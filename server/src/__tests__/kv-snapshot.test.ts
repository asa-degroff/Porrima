import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { LlamaSlotLease } from "../services/llama-slot-leases.js";

/**
 * Tests for KV snapshot parking (docs/design/kv-snapshot-parking.md):
 * registry lifecycle, save-policy gates, supersede/rollback, budget pruning,
 * restore gate, and the 10-11 review fixes (slot probe, wire-failure strikes,
 * min-build gate, slot-identity save guard, estimate ordering).
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
  buildTag?: string;
  slots?: Array<Record<string, unknown>>;
  slotsFetchError?: boolean;
} = {}): Promise<Harness> {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  vi.resetModules();
  const home = mkdtempSync(join(tmpdir(), "kvsnap-"));
  process.env.PORRIMA_DATA_DIR = home;

  const streamsMap = new Map();
  vi.doMock("../services/live-streams.js", () => ({ liveStreams: streamsMap }));
  // Build identity comes from the running binary (llama-build-probe) — mock
  // the module seam so the tag is deterministic in any environment.
  vi.doMock("../services/llama-build-probe.js", () => ({
    resolveLlamaBuildTag: vi.fn(async () => options.buildTag ?? "b11552"),
  }));
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
      prefix_digest: seed.prefixDigest ?? "",
      build_tag: seed.buildTag ?? "",
      config_digest: "",
      state: seed.state ?? "ready",
      saved_at: seed.savedAt ?? BASE_TIME,
      last_used_at: seed.lastUsedAt ?? BASE_TIME,
      restore_count: 0,
      miss_count: seed.missCount ?? 0,
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
    const u = String(url);
    if (u.includes("action=save")) {
      return Response.json({
        id_slot: 2,
        filename: "x.bin",
        n_saved: 150_050,
        n_written: 6_398_851_904,
        timings: { save_ms: 4715.1 },
      });
    }
    if (u.includes("action=restore")) {
      return Response.json({
        id_slot: 2,
        filename: "x.bin",
        n_restored: 134_050,
        n_read: 6_398_851_904,
        timings: { restore_ms: 2098.4 },
      });
    }
    if (u.endsWith("/slots")) {
      if (options.slotsFetchError) throw new Error("slots probe failed");
      // Cold pinned slot by default: tier 1 holds nothing, restore may fire.
      return Response.json(
        options.slots ?? [{ id: 2, n_ctx: 262144, is_processing: false, n_prompt_tokens: 0 }],
      );
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
    expect(row?.nTokens).toBe(150_050); // n_saved from the wire, not the estimate
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

  it("refuses to park when the live build is below the parking minimum (no row touched)", async () => {
    const h = await loadHarness({ seedPromptTokens: 150_000, buildTag: "b11000" });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(0);
    expect(h.kv.getKvSnapshot(lease.chatId)).toBeNull();
    h.db.close();
  });

  it("honours an explicit lower kvSnapshotMinBuild", async () => {
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      buildTag: "b11000",
      settings: { kvSnapshotMinBuild: 10_000 },
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(1);
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("ready");
    h.db.close();
  });

  it("discards a save whose n_saved is below the finished turn's prompt (slot reassigned mid-save)", async () => {
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      seedSnapshots: [{ state: "ready", filename: "prior.bin", nTokens: 100_000, bytes: 1_000, savedAt: BASE_TIME - 60 * 60_000 }],
      fetchImpl: async (url) => {
        if (url.includes("action=save")) {
          return Response.json({ n_saved: 4_000, n_written: 2_000_000, timings: { save_ms: 10 } });
        }
        return Response.json([{ id: 2, n_prompt_tokens: 0 }]);
      },
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    const row = h.kv.getKvSnapshot(lease.chatId);
    expect(row?.state).toBe("ready");
    expect(row?.filename).toBe("prior.bin"); // the good snapshot survives
    expect(row?.nTokens).toBe(100_000);
    h.db.close();
  });

  it("estimates from the prior bytes/n_tokens ratio, read before the saving upsert", async () => {
    // Own prior: 50_000 tokens / 1_000 bytes → 0.02 B/token. New turn at
    // 150_000 tokens → honest estimate 3_000 bytes. With a 2_500-byte pool
    // cap the 2_000-byte peer must be LRU-evicted; the corrupted ratio a
    // post-upsert read would produce (1_000 / 150_000 → 1_000-byte estimate)
    // would leave the pool over cap.
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      settings: { kvSnapshotMaxBytesPerPool: 2_500 },
      seedSnapshots: [
        { chatId: "peer", state: "ready", nTokens: 50_000, bytes: 2_000, lastUsedAt: BASE_TIME - 60_000, savedAt: BASE_TIME - 60_000 },
        { state: "ready", nTokens: 50_000, bytes: 1_000, savedAt: BASE_TIME - 120_000 },
      ],
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(h.kv.getKvSnapshot("peer")).toBeNull();
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("ready");
    h.db.close();
  });
});

describe("kv-snapshot post-warm park (§5.3a, 10-17)", () => {
  it("skips without a lease (auto binding mode degrades to no park)", async () => {
    const h = await loadHarness();
    await h.kv.parkAfterWarm({ chatId: lease.chatId, lease: null, promptTokens: 150_000, prefixDigest: "d" });
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.kv.getKvSnapshot(lease.chatId)).toBeNull();
    h.db.close();
  });

  it("is inert when the feature is disabled", async () => {
    const h = await loadHarness({ settings: { kvSnapshotEnabled: false } });
    await h.kv.parkAfterWarm({ chatId: lease.chatId, lease, promptTokens: 150_000, prefixDigest: "d" });
    expect(saveCalls(h.fetchMock)).toHaveLength(0);
    h.db.close();
  });

  it("skips below the token floor (wire-truth warm size)", async () => {
    const h = await loadHarness();
    await h.kv.parkAfterWarm({ chatId: lease.chatId, lease, promptTokens: 500, prefixDigest: "d" });
    expect(saveCalls(h.fetchMock)).toHaveLength(0);
    expect(h.kv.getKvSnapshot(lease.chatId)).toBeNull();
    h.db.close();
  });

  it("skips when a ready row already holds the same head digest", async () => {
    const h = await loadHarness({
      seedSnapshots: [
        { state: "ready", filename: "old.bin", prefixDigest: "same-digest", nTokens: 150_000, savedAt: BASE_TIME - 1_000 },
      ],
    });
    await h.kv.parkAfterWarm({ chatId: lease.chatId, lease, promptTokens: 150_000, prefixDigest: "same-digest" });
    expect(saveCalls(h.fetchMock)).toHaveLength(0);
    expect(h.kv.getKvSnapshot(lease.chatId)?.filename).toBe("old.bin"); // untouched
    h.db.close();
  });

  it("saves on digest drift and stamps the WARM digest, unlinks the superseded file", async () => {
    const h = await loadHarness({
      seedSnapshots: [
        { state: "ready", filename: "old.bin", prefixDigest: "old-digest", nTokens: 150_000, savedAt: BASE_TIME - 1_000 },
      ],
    });
    writeFileSync(join(h.home, "kv-cache", "old.bin"), "x");
    await h.kv.parkAfterWarm({ chatId: lease.chatId, lease, promptTokens: 150_000, prefixDigest: "warm-digest" });
    expect(saveCalls(h.fetchMock)).toHaveLength(1);
    const row = h.kv.getKvSnapshot(lease.chatId);
    expect(row?.state).toBe("ready");
    expect(row?.prefixDigest).toBe("warm-digest");
    expect(row?.filename).not.toBe("old.bin");
    expect(existsSync(join(h.home, "kv-cache", "old.bin"))).toBe(false);
    h.db.close();
  });

  it("parks with no prior row (first warm park)", async () => {
    const h = await loadHarness();
    await h.kv.parkAfterWarm({ chatId: lease.chatId, lease, promptTokens: 150_000, prefixDigest: "warm-digest" });
    expect(saveCalls(h.fetchMock)).toHaveLength(1);
    const row = h.kv.getKvSnapshot(lease.chatId);
    expect(row?.state).toBe("ready");
    expect(row?.prefixDigest).toBe("warm-digest");
    h.db.close();
  });

  it("a later warm pass supersedes an in-flight save from an earlier one", async () => {
    // Field-realizable ordering: the warm queue serializes passes per chat,
    // so pass 2's token bump lands after pass 1's but before pass 1's save
    // completes. Gate pass 1's save wire call to hold it mid-write.
    let saveCount = 0;
    let resolveFirstSave: ((r: Response) => void) | null = null;
    const h = await loadHarness({
      fetchImpl: async (url) => {
        if (url.includes("action=save")) {
          saveCount++;
          if (saveCount === 1) {
            return new Promise<Response>((resolve) => {
              resolveFirstSave = resolve;
            });
          }
          return Response.json({ n_saved: 150_050, n_written: 6_000_000_000, timings: { save_ms: 1 } });
        }
        return Response.json([{ id: 2, n_prompt_tokens: 0 }]);
      },
    });
    const first = h.kv.parkAfterWarm({ chatId: lease.chatId, lease, promptTokens: 150_000, prefixDigest: "d1" });
    for (let i = 0; i < 10 && saveCount < 1; i++) await vi.advanceTimersByTimeAsync(1);
    expect(saveCount).toBe(1); // pass 1's job is parked on the gated save fetch
    const second = h.kv.parkAfterWarm({ chatId: lease.chatId, lease, promptTokens: 150_000, prefixDigest: "d2" });
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1); // pass 2 bumps the token, queues behind pass 1
    resolveFirstSave!(
      Response.json({ n_saved: 150_050, n_written: 6_000_000_000, timings: { save_ms: 1 } }),
    );
    await Promise.all([first, second]);
    // Pass 1's capture is superseded (token check), pass 2 owns the row.
    expect(saveCalls(h.fetchMock)).toHaveLength(2);
    const row = h.kv.getKvSnapshot(lease.chatId);
    expect(row?.state).toBe("ready");
    expect(row?.prefixDigest).toBe("d2");
    h.db.close();
  });

  it("an invalidate landing after the token bump, mid-save, supersedes the capture", async () => {
    // The real ordering: the warm holds the turn gate, so its token bump
    // precedes any new turn; only a spine rewrite landing between the bump
    // and the completed write can supersede the job (compaction mid-save).
    let resolveSave: ((r: Response) => void) | null = null;
    let saveIssued = false;
    const h = await loadHarness({
      seedSnapshots: [
        { state: "ready", filename: "prior.bin", prefixDigest: "old-digest", nTokens: 100_000, bytes: 1_000 },
      ],
      fetchImpl: async (url) => {
        if (url.includes("action=save")) {
          saveIssued = true;
          return new Promise<Response>((resolve) => {
            resolveSave = resolve;
          });
        }
        return Response.json([{ id: 2, n_prompt_tokens: 0 }]);
      },
    });
    writeFileSync(join(h.home, "kv-cache", "prior.bin"), "x");
    const park = h.kv.parkAfterWarm({ chatId: lease.chatId, lease, promptTokens: 150_000, prefixDigest: "warm-digest" });
    // Let the job run deterministically to the (gated) save fetch: under fake
    // timers the async module hops resolve via the async timer flush, not
    // runAllTicks (the dynamic-import microtasks ride the loader queue).
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1);
      if (saveIssued) break;
    }
    expect(saveIssued).toBe(true);
    await h.kv.invalidateKvSnapshot(lease.chatId, "compaction");
    resolveSave!(
      Response.json({ n_saved: 150_050, n_written: 6_000_000_000, timings: { save_ms: 1 } }),
    );
    await park;
    expect(h.kv.getKvSnapshot(lease.chatId)).toBeNull(); // row deleted; superseded job rolled back into nothing
    // The invalidate unlinked the CURRENT row's file (the in-flight "saving"
    // capture); the displaced prior.bin is now an orphan — the prune sweep's
    // jurisdiction, not the job's.
    expect(existsSync(join(h.home, "kv-cache", "prior.bin"))).toBe(true);
    h.db.close();
  });

  it("keeps the prior ready snapshot when the save fails", async () => {
    const h = await loadHarness({
      seedSnapshots: [
        { state: "ready", filename: "prior.bin", prefixDigest: "old-digest", nTokens: 100_000, bytes: 1_000, savedAt: BASE_TIME - 60 * 60_000 },
      ],
      fetchImpl: async (url) => {
        if (url.includes("action=save")) {
          return Response.json({ error: { message: "disk full" } }, { status: 500 });
        }
        return Response.json([{ id: 2, n_prompt_tokens: 0 }]);
      },
    });
    await h.kv.parkAfterWarm({ chatId: lease.chatId, lease, promptTokens: 150_000, prefixDigest: "warm-digest" });
    const row = h.kv.getKvSnapshot(lease.chatId);
    expect(row?.state).toBe("ready");
    expect(row?.filename).toBe("prior.bin"); // the good snapshot survives
    h.db.close();
  });

  it("discards a save whose n_saved is below the warm prompt (slot reassigned mid-save)", async () => {
    const h = await loadHarness({
      seedSnapshots: [
        { state: "ready", filename: "prior.bin", prefixDigest: "old-digest", nTokens: 100_000, bytes: 1_000, savedAt: BASE_TIME - 60 * 60_000 },
      ],
      fetchImpl: async (url) => {
        if (url.includes("action=save")) {
          return Response.json({ n_saved: 4_000, n_written: 2_000_000, timings: { save_ms: 10 } });
        }
        return Response.json([{ id: 2, n_prompt_tokens: 0 }]);
      },
    });
    await h.kv.parkAfterWarm({ chatId: lease.chatId, lease, promptTokens: 150_000, prefixDigest: "warm-digest" });
    const row = h.kv.getKvSnapshot(lease.chatId);
    expect(row?.state).toBe("ready");
    expect(row?.filename).toBe("prior.bin"); // the good snapshot survives
    h.db.close();
  });
});

describe("kv-snapshot spine-rewrite suppression (§5.5 invalidate-then-release race)", () => {
  // The 2026-10-15 production race: end-of-turn compaction invalidates the
  // snapshot (deleting row + file), then the lease release parks the slot's
  // pre-rewrite state anyway — the slot holds exactly what the rewrite made
  // obsolete, and the wire-head digest cannot tell (compaction rewrites the
  // messages, not [system, tools]). The gate: a park needs its slot witness
  // (the last DONE chat request) to post-date the last rewrite.

  it("suppresses a park enqueued after the last wire turn was invalidated", async () => {
    const h = await loadHarness({ seedPromptTokens: 150_000 });
    vi.setSystemTime(BASE_TIME + 60_000);
    await h.kv.invalidateKvSnapshot(lease.chatId, "compaction");
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(0);
    expect(h.kv.getKvSnapshot(lease.chatId)).toBeNull();
    h.db.close();
  });

  it("re-arms the park once a post-rewrite turn fills the slot", async () => {
    const h = await loadHarness({ seedPromptTokens: 150_000 });
    vi.setSystemTime(BASE_TIME + 60_000);
    await h.kv.invalidateKvSnapshot(lease.chatId, "compaction");
    // The next real turn: its DONE request is the slot's new witness.
    h.db
      .prepare(
        "INSERT INTO llm_requests (id, chat_id, timestamp, model_id, provider, status, prompt_tokens) VALUES (?,?,?,?,?,?,?)",
      )
      .run("req-2", lease.chatId, BASE_TIME + 90_000, lease.modelId, "llamacpp", "done", 150_050);
    vi.setSystemTime(BASE_TIME + 120_000);
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(1);
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("ready");
    h.db.close();
  });

  it("discards a save whose invalidation lands mid-flight", async () => {
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      fetchImpl: async (url) => {
        if (String(url).includes("action=save")) {
          // Invalidation arriving while the write is in flight: the file may
          // land, but it must never be registered as a ready snapshot.
          await h.kv.invalidateKvSnapshot(lease.chatId, "compaction");
          return Response.json({
            id_slot: 2,
            filename: "x.bin",
            n_saved: 150_050,
            n_written: 1_000,
            timings: { save_ms: 1 },
          });
        }
        return Response.json({ error: { message: "unexpected url" } }, { status: 404 });
      },
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(1); // the save fired...
    expect(h.kv.getKvSnapshot(lease.chatId)).toBeNull(); // ...but nothing survived
    h.db.close();
  });

  it("a deleted chat cannot resurrect a snapshot through a racing release-park", async () => {
    const h = await loadHarness({ seedPromptTokens: 150_000 });
    vi.setSystemTime(BASE_TIME + 30_000);
    await h.kv.invalidateKvSnapshot(lease.chatId, "chat-deleted");
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(0);
    expect(h.kv.getKvSnapshot(lease.chatId)).toBeNull();
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

// ---------------------------------------------------------------------------
// Phase 3: restore gate, digest stamp, usage-confirmed breaker
// ---------------------------------------------------------------------------

describe("kv-snapshot save budget (scaled)", () => {
  it("grows with estimated bytes, floors at opTimeoutMs headroom, caps at 5 min", async () => {
    const h = await loadHarness();
    const policy = h.kv.resolveKvSnapshotSettings({ kvSnapshotOpTimeoutMs: 60_000 });
    const MiB = 1024 * 1024;

    // 1 MiB -> ceil(1/512MiB)=1 -> +2 s headroom
    expect(h.kv.computeSaveBudgetMs(1 * MiB, policy)).toBe(62_000);
    // The measured case that worked: 18.5 GiB / 24 s actual -> 60 s + 74 s budget
    expect(h.kv.computeSaveBudgetMs(18.5 * 1024 * MiB, policy)).toBe(134_000);
    // The case that TIMED OUT (21:48, 203k tokens ~= 35 GiB): 60 s + 140 s
    expect(h.kv.computeSaveBudgetMs(35 * 1024 * MiB, policy)).toBe(200_000);
    // Absolute ceiling for anything larger.
    expect(h.kv.computeSaveBudgetMs(600 * 1024 * MiB, policy)).toBe(300_000);
    h.db.close();
  });
});

const wireBody = {
  messages: [{ role: "system", content: "You are a frozen prefix." }, { role: "user", content: "hi" }],
  tools: [{ type: "function", function: { name: "a" } }],
  stream: true,
};

const restoreCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("action=restore"));

const parkedSeed = { state: "ready", nTokens: 134_050, bytes: 6_398_851_904, savedAt: BASE_TIME - 5 * 60_000 };

describe("kv-snapshot restore gate (Phase 3)", () => {
  it("restores before iteration 1 of a cold, parked, pinned turn — once per turn", async () => {
    const h = await loadHarness({ seedSnapshots: [parkedSeed] });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 1 });

    const calls = restoreCalls(h.fetchMock);
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toBe(`http://localhost:8080/slots/${lease.slotId}?action=restore`);
    expect(JSON.parse(calls[0][1].body).filename).toBe("old.bin");
    expect(h.kv.getKvSnapshot(lease.chatId)?.restoreCount).toBe(1);

    // Same turn: never re-attempt (iterations 2..n and replays alike).
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 2 });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(1);
    h.db.close();
  });

  it("ignores non-first iterations (but still observes the digest)", async () => {
    const h = await loadHarness({ seedSnapshots: [parkedSeed] });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 2 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(0);
    h.db.close();
  });

  it("skips on prefix-digest drift without touching the row", async () => {
    const h = await loadHarness({ seedSnapshots: [{ ...parkedSeed, prefixDigest: "deadbeef" }] });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(0);
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("ready");
    h.db.close();
  });

  it("defers when the pinned slot still holds most of the parked prefix (slot probe)", async () => {
    // parkedSeed has nTokens 134_050 → warm threshold 67_025. Slot reports
    // 130_000 prompt tokens: tier 1 will serve this turn, no restore.
    const h = await loadHarness({
      seedSnapshots: [parkedSeed],
      slots: [{ id: 2, is_processing: false, n_prompt_tokens: 130_000 }],
    });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(0);
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("ready");
    h.db.close();
  });

  it("skips (without state change) when the slot probe fails", async () => {
    const h = await loadHarness({ seedSnapshots: [parkedSeed], slotsFetchError: true });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(0);
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("ready");
    expect(h.kv.getKvSnapshot(lease.chatId)?.missCount).toBe(0);
    h.db.close();
  });

  it("invalidates on build-tag mismatch", async () => {
    const h = await loadHarness({ seedSnapshots: [{ ...parkedSeed, buildTag: "b11000" }] });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(0);
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("stale");
    h.db.close();
  });

  it("keeps the restore breaker closed at two misses", async () => {
    const h = await loadHarness({ seedSnapshots: [{ ...parkedSeed, missCount: 2 }] });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(0);
    h.db.close();
  });

  it("counts wire-level restore failures as breaker strikes", async () => {
    // A persistently bad file (build-incompatible, torn write) must stop
    // after two failed attempts instead of retrying on every cold turn.
    const h = await loadHarness({
      seedSnapshots: [parkedSeed],
      fetchImpl: async (url) => {
        if (url.includes("action=restore")) {
          return Response.json({ error: { message: "file version mismatch" } }, { status: 500 });
        }
        return Response.json([{ id: 2, n_prompt_tokens: 0 }]);
      },
    });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t-w1", iteration: 1 });
    expect(h.kv.getKvSnapshot(lease.chatId)?.missCount).toBe(1);
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t-w2", iteration: 1 });
    expect(h.kv.getKvSnapshot(lease.chatId)?.missCount).toBe(2);
    // Breaker closed: the third turn makes no attempt at all.
    const attemptsSoFar = restoreCalls(h.fetchMock).length;
    expect(attemptsSoFar).toBe(2);
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t-w3", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(2);
    h.db.close();
  });

  it("skips when the chat moved pools or the feature is off", async () => {
    const h = await loadHarness({ seedSnapshots: [{ ...parkedSeed, poolKey: "other-pool" }] });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(0);
    h.db.close();

    const h2 = await loadHarness({ settings: { kvSnapshotEnabled: false }, seedSnapshots: [parkedSeed] });
    await h2.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 1 });
    expect(restoreCalls(h2.fetchMock)).toHaveLength(0);
    h2.db.close();
  });

  it("parks stamp the observed wire-head digest and reset the breaker", async () => {
    const h = await loadHarness({ seedPromptTokens: 150_000 });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t0", iteration: 1 });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });

    const row = h.kv.getKvSnapshot(lease.chatId);
    expect(row?.state).toBe("ready");
    expect(row?.prefixDigest).toBe(h.kv.computeLlamaPrefixDigest(wireBody));
    expect(row?.prefixDigest).toMatch(/^[0-9a-f]{64}$/);

    // A re-park resets a previously tripped breaker.
    h.db.prepare("UPDATE kv_snapshots SET miss_count = 5 WHERE chat_id = ?").run(lease.chatId);
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    // (debounce skips the second park; age saved_at past the debounce window —
    // shrinking n_tokens would corrupt the honest bytes/n_tokens estimate)
    h.db.prepare("UPDATE kv_snapshots SET saved_at = ? WHERE chat_id = ?").run(BASE_TIME - 100_000, lease.chatId);
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(h.kv.getKvSnapshot(lease.chatId)?.missCount).toBe(0);
    h.db.close();
  });
});

// ---------------------------------------------------------------------------
// Shared-slot semantics (doc §7 D9): the single-slot launch multiplexes every
// chat onto one slot. Two rules follow: the tier-1 count probe only witnesses
// for the slot's last writer, and restores serialize on the slot's chain.
// ---------------------------------------------------------------------------

const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("kv-snapshot shared-slot restore (§7 D9)", () => {
  it("restores when a different chat last held the slot, despite a warm token count", async () => {
    const otherChat = "22222222-2222-2222-2222-222222222222";
    // Slot reports 130k prompt tokens: the OLD count-only gate would skip the
    // restore. The count belongs to the OTHER chat (it recorded ownership via
    // a park entry below the token floor) — the gate must treat the slot as
    // cold and restore without consulting the meaningless count.
    const h = await loadHarness({
      seedSnapshots: [parkedSeed],
      slots: [{ id: lease.slotId, is_processing: false, n_prompt_tokens: 130_000 }],
    });
    await h.kv.parkAfterWarm({
      chatId: otherChat,
      lease: { ...lease, chatId: otherChat },
      promptTokens: 0, // below-min: the park skips, the ownership witness lands
      prefixDigest: "x",
    });

    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(1);
    // The probe is bypassed entirely: GET /slots was never asked.
    expect(h.fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/slots"))).toHaveLength(0);

    // A successful restore re-records ownership. The next turn sees its own
    // state in the slot, so the warm count probe's verdict applies again and
    // the restore is skipped (tier 1 / restored state serves).
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t2", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(1);
    h.db.close();
  });

  it("keeps the count-probe verdict for the slot's own last writer", async () => {
    const h = await loadHarness({
      seedSnapshots: [parkedSeed],
      slots: [{ id: lease.slotId, is_processing: false, n_prompt_tokens: 130_000 }],
    });
    // This chat is the slot's last writer: the warm count is evidence about
    // its own prefix and the restore defers (today's behavior, unchanged).
    await h.kv.parkAfterWarm({ chatId: lease.chatId, lease, promptTokens: 0, prefixDigest: "x" });
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t1", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(0);
    expect(h.fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/slots"))).toHaveLength(1);
    h.db.close();
  });

  it("chains a restore behind an in-flight save on the same slot", async () => {
    const returner = "33333333-3333-3333-3333-333333333333";
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      seedSnapshots: [{ ...parkedSeed, chatId: returner }],
      fetchImpl: async (url) => {
        if (url.includes("action=save")) {
          markSaveStarted();
          await saveGate;
          return Response.json({ n_saved: 150_050, n_written: 1_000, timings: { save_ms: 10 } });
        }
        if (url.includes("action=restore")) {
          return Response.json({ n_restored: 134_050, n_read: 1_000, timings: { restore_ms: 10 } });
        }
        return Response.json([{ id: lease.slotId, n_prompt_tokens: 0 }]);
      },
    });

    // Chat A finishes its turn; its park save is in flight (blocked).
    const park = h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    await saveStarted;

    // Chat B returns: its restore must queue BEHIND the in-flight save — that
    // save still captures A's valid pre-restore state; a restore issued over
    // it would land first and poison A's snapshot.
    const observe = h.kv.observeLlamaRequestBody({ chatId: returner, lease, body: wireBody, turnId: "t1", iteration: 1 });
    await flushMicrotasks();
    expect(restoreCalls(h.fetchMock)).toHaveLength(0);

    releaseSave();
    await park;
    await observe;
    expect(restoreCalls(h.fetchMock)).toHaveLength(1);
    const urls = h.fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.findIndex((u) => u.includes("action=save"))).toBeLessThan(
      urls.findIndex((u) => u.includes("action=restore")),
    );
    h.db.close();
  });

  it("cancels other chats' queued saves before a foreground restore", async () => {
    const chatB = "44444444-4444-4444-4444-444444444444";
    const chatD = "55555555-5555-5555-5555-555555555555";
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      seedSnapshots: [{ ...parkedSeed, chatId: chatD }],
      fetchImpl: async (url) => {
        if (url.includes("action=save")) {
          markSaveStarted();
          await saveGate;
          return Response.json({ n_saved: 150_050, n_written: 1_000, timings: { save_ms: 10 } });
        }
        if (url.includes("action=restore")) {
          return Response.json({ n_restored: 134_050, n_read: 1_000, timings: { restore_ms: 10 } });
        }
        return Response.json([{ id: lease.slotId, n_prompt_tokens: 0 }]);
      },
    });
    // Give chat B a wire-truth DONE turn so it is park-eligible.
    h.db
      .prepare(
        "INSERT INTO llm_requests (id, chat_id, timestamp, model_id, provider, status, prompt_tokens) VALUES (?,?,?,?,?,?,?)",
      )
      .run("req-b", chatB, BASE_TIME, lease.modelId, "llamacpp", "done", 150_000);

    const parkA = h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    await saveStarted;
    // B's park queues behind A's in-flight save (unstarted descriptor).
    const parkB = h.kv.maybeParkChatAfterTurn({ chatId: chatB, lease: { ...lease, chatId: chatB } });
    await flushMicrotasks();

    // D's restore cancels B's queued capture — the slot's content is about to
    // be replaced with D's state, and B parking THAT would register D's KV
    // under B's row. Flush observe's pre-scan awaits first so the cancel is
    // deterministically applied before the save backlog drains.
    const observe = h.kv.observeLlamaRequestBody({ chatId: chatD, lease, body: wireBody, turnId: "t1", iteration: 1 });
    await flushMicrotasks();
    expect(restoreCalls(h.fetchMock)).toHaveLength(0); // still chained behind A

    releaseSave();
    await Promise.all([parkA, parkB, observe]);

    // Only A's save ran; B dropped itself before touching the slot API or the
    // registry; D's restore executed.
    expect(saveCalls(h.fetchMock)).toHaveLength(1);
    expect(restoreCalls(h.fetchMock)).toHaveLength(1);
    expect(h.kv.getKvSnapshot(chatB)).toBeNull();
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("ready");
    h.db.close();
  });
});

describe("kv-snapshot summary surface (Phase 4)", () => {
  it("aggregates pool totals, policy, and free disk for the status panel", async () => {
    const h = await loadHarness({
      seedSnapshots: [
        { chatId: "p1", bytes: 4_000, nTokens: 50_000, lastUsedAt: BASE_TIME },
        {
          chatId: "p2", bytes: 7_000, nTokens: 90_000, lastUsedAt: BASE_TIME,
          poolKey: "other-pool", baseUrl: "http://localhost:9090", modelId: "other-model",
        },
      ],
    });

    const summary = await h.kv.getKvSnapshotSummary();

    expect(summary.enabled).toBe(true);
    expect(summary.policy.minTokens).toBe(1_000);
    expect(summary.snapshots).toHaveLength(2);
    expect(summary.pools).toHaveLength(2);
    const primary = summary.pools.find((p) => p.poolKey === lease.poolKey);
    expect(primary?.count).toBe(1);
    expect(primary?.bytes).toBe(4_000);
    expect(summary.freeDiskBytes).toBe(1_073_741_824 * 1024);
    h.db.close();
  });
});

describe("kv-snapshot usage-confirmed breaker", () => {
  async function restoreThenVerify(h: Harness, turnId: string, usage: { input: number; cacheRead: number }) {
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId, iteration: 1 });
    const { recordLlmRequestStart, recordLlmRequestEnd } = await import("../services/request-log.js");
    recordLlmRequestStart({
      chatId: lease.chatId,
      requestId: `${turnId}:1`,
      turnId,
      iteration: 1,
      modelId: lease.modelId,
      provider: "llamacpp",
      body: wireBody,
    });
    recordLlmRequestEnd({
      chatId: lease.chatId,
      requestId: `${turnId}:1`,
      status: "done",
      output: { usage: { input: usage.input, output: 8, cacheRead: usage.cacheRead } as any },
    });
  }

  it("a confirmed-miss restore trips the breaker after two strikes", async () => {
    const h = await loadHarness({ seedSnapshots: [parkedSeed] });

    await restoreThenVerify(h, "t-miss-1", { input: 150_000, cacheRead: 10 }); // cold: miss #1
    expect(h.kv.getKvSnapshot(lease.chatId)?.missCount).toBe(1);

    await restoreThenVerify(h, "t-miss-2", { input: 150_000, cacheRead: 10 }); // miss #2
    expect(h.kv.getKvSnapshot(lease.chatId)?.missCount).toBe(2);

    // Breaker closed: no restore attempt on the third turn.
    await h.kv.observeLlamaRequestBody({ chatId: lease.chatId, lease, body: wireBody, turnId: "t-miss-3", iteration: 1 });
    expect(restoreCalls(h.fetchMock)).toHaveLength(2);
    h.db.close();
  });

  it("a hit (cached >= 50%) resets the miss count", async () => {
    const h = await loadHarness({ seedSnapshots: [{ ...parkedSeed, missCount: 1 }] });
    await restoreThenVerify(h, "t-hit", { input: 150_000, cacheRead: 148_000 });
    const row = h.kv.getKvSnapshot(lease.chatId);
    expect(row?.missCount).toBe(0);
    expect(row?.restoreCount).toBe(1);
    h.db.close();
  });

  it("usage events for turns without a pending restore are ignored", async () => {
    const h = await loadHarness({ seedSnapshots: [parkedSeed] });
    const { recordLlmRequestStart, recordLlmRequestEnd } = await import("../services/request-log.js");
    recordLlmRequestStart({
      chatId: lease.chatId, requestId: "no-restore:1", turnId: "no-restore", iteration: 1,
      modelId: lease.modelId, provider: "llamacpp", body: wireBody,
    });
    recordLlmRequestEnd({
      chatId: lease.chatId, requestId: "no-restore:1", status: "done",
      output: { usage: { input: 150_000, output: 8, cacheRead: 0 } as any },
    });
    expect(h.kv.getKvSnapshot(lease.chatId)?.missCount).toBe(0);
    h.db.close();
  });
});

describe("parking capability refusals (docs/design/strata-backend.md §7)", () => {
  it("marks the URL unsupported when a save is refused at config level (400 invalid) and later turns skip", async () => {
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      fetchImpl: async (url: string) => {
        if (url.includes("action=save")) {
          return Response.json(
            { error: { code: 400, message: "session files do not support --layer-split", type: "invalid_request_error", kind: "invalid" } },
            { status: 400 },
          );
        }
        return Response.json([]);
      },
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(1);
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("stale");
    // Next turn on the same URL: suppressed at the gate — no save attempt,
    // no per-turn failed multi-GB capture attempt again.
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(1);
    h.db.close();
  });

  it("an unclassified save failure does not mark the URL unsupported", async () => {
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      fetchImpl: async (url: string) => {
        if (url.includes("action=save")) {
          return Response.json({ error: { message: "transient write error" } }, { status: 400 });
        }
        return Response.json([]);
      },
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(2);
    h.db.close();
  });
});
