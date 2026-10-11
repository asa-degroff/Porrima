import Database from "better-sqlite3";
import { access, readdir, statfs, unlink } from "fs/promises";
import { appDataPath, KV_CACHE_DIR } from "./paths.js";
import type { LlamaSlotLease } from "./llama-slot-leases.js";
import { liveStreams } from "./live-streams.js";

/**
 * KV snapshot parking — Phase 2 (registry + save + budget/prune) of
 * docs/design/kv-snapshot-parking.md.
 *
 * At end of turn, chats whose context outgrows llama.cpp's RAM prompt cache are
 * parked to NVMe via `POST /slots/{id}?action=save`, so a later cold return can
 * restore (~seconds) instead of re-prefilling (~minutes at 200 tok/s). This
 * phase is intentionally invisible: rows, files, and metrics accrue behind the
 * `kvSnapshotEnabled` setting (off by default, D8); the restore path lands in
 * Phase 3.
 *
 * Invariants (doc §2/§9):
 * - Pure optimization. Every failure degrades to today's cold prefill. This
 *   module must never throw into a turn — every entry point is total.
 * - Eligibility keys on WIRE-TRUTH `usage.prompt_tokens` from the just-finished
 *   iteration (D7), never an estimate.
 * - All state moves through the server's `/slots` API; this service never
 *   writes snapshot files directly, and files are ephemeral per
 *   `(build, config)` — invalidation is by digest/overwrite, never migration.
 * - A save replaces the previous file only after the new save succeeds; a
 *   failed save leaves a prior `ready` snapshot intact.
 */

const DB_PATH = appDataPath("porrima.db");
const LOG = "[kv-snapshot]";

// ---------------------------------------------------------------------------
// Settings (§8) — keys defined Phase 1, consumed here.
// ---------------------------------------------------------------------------

export interface KvSnapshotSettings {
  enabled: boolean;
  minTokens: number;
  saveDebounceMs: number;
  minGrowthTokens: number;
  maxBytesPerPool: number;
  ttlHours: number;
  minFreeDiskBytes: number;
  opTimeoutMs: number;
}

const GIB = 1024 * 1024 * 1024;

export const KV_SNAPSHOT_DEFAULTS = {
  enabled: false,
  minTokens: 65_536,
  saveDebounceMs: 90_000,
  minGrowthTokens: 2_048,
  maxBytesPerPool: 256 * GIB,
  ttlHours: 72,
  minFreeDiskBytes: 64 * GIB,
  opTimeoutMs: 60_000,
} as const;

export function resolveKvSnapshotSettings(settings: any): KvSnapshotSettings {
  return {
    enabled: settings?.kvSnapshotEnabled === true,
    minTokens: positiveOr(settings?.kvSnapshotMinTokens, KV_SNAPSHOT_DEFAULTS.minTokens),
    saveDebounceMs: nonNegativeOr(settings?.kvSnapshotSaveDebounceMs, KV_SNAPSHOT_DEFAULTS.saveDebounceMs),
    minGrowthTokens: nonNegativeOr(settings?.kvSnapshotMinGrowthTokens, KV_SNAPSHOT_DEFAULTS.minGrowthTokens),
    maxBytesPerPool: positiveOr(settings?.kvSnapshotMaxBytesPerPool, KV_SNAPSHOT_DEFAULTS.maxBytesPerPool),
    ttlHours: positiveOr(settings?.kvSnapshotTtlHours, KV_SNAPSHOT_DEFAULTS.ttlHours),
    minFreeDiskBytes: nonNegativeOr(settings?.kvSnapshotMinFreeDiskBytes, KV_SNAPSHOT_DEFAULTS.minFreeDiskBytes),
    opTimeoutMs: positiveOr(settings?.kvSnapshotOpTimeoutMs, KV_SNAPSHOT_DEFAULTS.opTimeoutMs),
  };
}

function positiveOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Registry (porrima.db, request-log pattern: create-on-open + startup sweep)
// ---------------------------------------------------------------------------

export type KvSnapshotState = "saving" | "ready" | "stale" | "restoring";

export interface KvSnapshotRow {
  chatId: string;
  poolKey: string;
  baseUrl: string;
  modelId: string;
  slotId: number;
  filename: string;
  nTokens: number;
  bytes: number;
  prefixDigest: string;
  buildTag: string;
  configDigest: string;
  state: KvSnapshotState;
  savedAt: number;
  lastUsedAt: number;
  restoreCount: number;
  missCount: number;
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    initSchema(db);
  }
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS kv_snapshots (
      chat_id        TEXT PRIMARY KEY,
      pool_key       TEXT NOT NULL,
      base_url       TEXT NOT NULL,
      model_id       TEXT NOT NULL,
      slot_id        INTEGER NOT NULL,
      filename       TEXT NOT NULL DEFAULT '',
      n_tokens       INTEGER NOT NULL DEFAULT 0,
      bytes          INTEGER NOT NULL DEFAULT 0,
      prefix_digest  TEXT NOT NULL DEFAULT '',
      build_tag      TEXT NOT NULL DEFAULT '',
      config_digest  TEXT NOT NULL DEFAULT '',
      state          TEXT NOT NULL DEFAULT 'stale',
      saved_at       INTEGER NOT NULL DEFAULT 0,
      last_used_at   INTEGER NOT NULL DEFAULT 0,
      restore_count  INTEGER NOT NULL DEFAULT 0,
      miss_count     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_kv_snapshots_pool ON kv_snapshots(pool_key, last_used_at DESC);
  `);

  // A restart always empties in-flight state: any row still mid-operation
  // belongs to a job that will never finalize (mirrors the llm_requests sweep).
  database
    .prepare("UPDATE kv_snapshots SET state = 'stale' WHERE state IN ('saving', 'restoring')")
    .run();
}

interface RowRecord {
  chat_id: string;
  pool_key: string;
  base_url: string;
  model_id: string;
  slot_id: number;
  filename: string;
  n_tokens: number;
  bytes: number;
  prefix_digest: string;
  build_tag: string;
  config_digest: string;
  state: string;
  saved_at: number;
  last_used_at: number;
  restore_count: number;
  miss_count: number;
}

function toRow(r: RowRecord): KvSnapshotRow {
  return {
    chatId: r.chat_id,
    poolKey: r.pool_key,
    baseUrl: r.base_url,
    modelId: r.model_id,
    slotId: r.slot_id,
    filename: r.filename,
    nTokens: r.n_tokens,
    bytes: r.bytes,
    prefixDigest: r.prefix_digest,
    buildTag: r.build_tag,
    configDigest: r.config_digest,
    state: r.state as KvSnapshotState,
    savedAt: r.saved_at,
    lastUsedAt: r.last_used_at,
    restoreCount: r.restore_count,
    missCount: r.miss_count,
  };
}

export function getKvSnapshot(chatId: string): KvSnapshotRow | null {
  const row = getDb()
    .prepare("SELECT * FROM kv_snapshots WHERE chat_id = ?")
    .get(chatId) as RowRecord | undefined;
  return row ? toRow(row) : null;
}

export function listKvSnapshots(): KvSnapshotRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM kv_snapshots ORDER BY last_used_at DESC")
    .all() as RowRecord[];
  return rows.map(toRow);
}

/** Open the registry, run the startup sweep. Idempotent; called from index.ts. */
export function initializeKvSnapshotStore(): void {
  getDb();
}

// ---------------------------------------------------------------------------
// Save policy (doc §5.3) — entry point for both turn-finalize paths.
// ---------------------------------------------------------------------------

/** Monotonic per-chat token: queued jobs whose token was superseded are
 *  dropped instead of executed (D3 queue + "drop if restarted"). */
const pendingTokens = new Map<string, number>();
/** Per-slot serialized chains: llama.cpp processes one slot task at a time and
 *  our own queue keeps the registry's view of each slot coherent. */
const slotQueues = new Map<string, Promise<void>>();

/**
 * Fire-and-forget end-of-turn entry. Called from the lease-release `finally` of
 * both the HTTP route and the headless runner; never rejects, never blocks.
 */
export async function maybeParkChatAfterTurn(input: {
  chatId: string;
  lease: LlamaSlotLease | null | undefined;
}): Promise<void> {
  try {
    const { chatId, lease } = input;
    if (!lease) return; // D2 pinning requirement: slot must be known (eligibility gate 2)

    const settings = await readSettings();
    const policy = resolveKvSnapshotSettings(settings);
    if (!policy.enabled) return;

    // Gate: wire-truth prompt size of the most recent DONE request (D7).
    const lastUsage = lastDonePromptTokens(chatId);
    if (lastUsage == null || lastUsage < policy.minTokens) return;

    // Gate: freshness (debounce + growth override).
    const existing = getKvSnapshot(chatId);
    const now = Date.now();
    if (
      existing &&
      existing.state === "ready" &&
      now - existing.savedAt < policy.saveDebounceMs &&
      lastUsage - existing.nTokens < policy.minGrowthTokens
    ) {
      return;
    }

    const token = (pendingTokens.get(chatId) ?? 0) + 1;
    pendingTokens.set(chatId, token);
    const streamAtEnqueue = liveStreams.get(chatId);

    const chainKey = `${lease.poolKey}#${lease.slotId}`;
    const previous = slotQueues.get(chainKey) ?? Promise.resolve();
    const job = previous.then(() =>
      runSaveJob({ chatId, lease, policy, token, lastUsage, streamAtEnqueue, existing }),
    );
    slotQueues.set(
      chainKey,
      job.catch(() => {}),
    );
    await job;
  } catch (error: any) {
    // Save policy failures are background noise by contract.
    console.warn(`${LOG} end-of-turn parking failed:`, error?.message || error);
  }
}

async function readSettings(): Promise<any> {
  try {
    const { getSettings } = await import("./chat-storage.js");
    return await getSettings();
  } catch (error: any) {
    console.warn(`${LOG} settings read failed:`, error?.message || error);
    return {};
  }
}

function lastDonePromptTokens(chatId: string): number | null {
  const row = getDb()
    .prepare(
      "SELECT prompt_tokens FROM llm_requests WHERE chat_id = ? AND status = 'done' AND purpose = 'chat' AND prompt_tokens IS NOT NULL ORDER BY timestamp DESC LIMIT 1",
    )
    .get(chatId) as { prompt_tokens: number } | undefined;
  return row?.prompt_tokens ?? null;
}

interface SaveJobInput {
  chatId: string;
  lease: LlamaSlotLease;
  policy: KvSnapshotSettings;
  token: number;
  lastUsage: number;
  streamAtEnqueue: ReturnType<typeof liveStreams.get>;
  existing: KvSnapshotRow | null;
}

async function runSaveJob(input: SaveJobInput): Promise<void> {
  const { chatId, lease, policy, token, lastUsage, streamAtEnqueue, existing } = input;

  // Drop-if-restarted (D3): a newer queued save, or a different (unended)
  // live stream than the one this save finalized, means this snapshot is stale
  // before it is even written.
  if (pendingTokens.get(chatId) !== token) return;
  const currentStream = liveStreams.get(chatId);
  if (currentStream && currentStream !== streamAtEnqueue && !currentStream.ended) {
    console.log(`${LOG} chat=${short(chatId)} skipped: turn restarted before save`);
    return;
  }

  const prior = existing;
  const filename = `${chatId}-${Date.now()}.bin`;
  const now = Date.now();

  // Claim the slot row in `saving`; keep the previous filename so a failed
  // save can roll the row back to whatever was actually true on disk.
  upsertSaving(chatId, lease, filename, lastUsage, now, prior);

  // Budget gate: pool LRU eviction first, then absolute disk headroom.
  const estimate = estimateBytes(chatId, lease.poolKey, lastUsage);
  evictPoolToBudget(lease.poolKey, estimate, chatId, policy);
  const free = await freeDiskBytes();
  if (free === null || free - policy.minFreeDiskBytes < estimate) {
    console.warn(
      `${LOG} chat=${short(chatId)} skipped: disk headroom (free=${formatGiB(free)}, estimate=${formatGiB(estimate)})`,
    );
    rollbackToPrior(chatId, prior);
    return;
  }

  if (pendingTokens.get(chatId) !== token) {
    rollbackToPrior(chatId, prior);
    return;
  }

  const buildTag = await probeBuildTag(lease.baseUrl);
  const save = await callSlotAction(lease, "save", filename, policy.opTimeoutMs);

  if (pendingTokens.get(chatId) !== token) {
    // Superseded mid-write: the file we just wrote may be a torn prefix of a
    // longer turn — discard it and let the newer job own the row.
    if (save.ok) await unlinkFile(snapshotPath(filename));
    rollbackToPrior(chatId, prior);
    return;
  }

  if (!save.ok) {
    console.warn(`${LOG} chat=${short(chatId)} save failed: ${save.error}`);
    // A previously-ready snapshot stays usable: its file is untouched and its
    // prefix is still a valid head of the chat's prompt (restore degrades to a
    // partial hit). Only an attempt with no prior success becomes stale.
    if (prior && prior.state === "ready") {
      restorePriorRow(chatId, prior);
    } else {
      setState(chatId, "stale");
    }
    return;
  }

  const { nSaved, nWritten, saveMs } = save;
  const database = getDb();
  database
    .prepare(
      `UPDATE kv_snapshots
         SET filename = ?, n_tokens = ?, bytes = ?, build_tag = ?, state = 'ready',
             saved_at = ?, last_used_at = ?
       WHERE chat_id = ?`,
    )
    .run(filename, nSaved ?? lastUsage, nWritten ?? estimate, buildTag, Date.now(), Date.now(), chatId);

  // Overwrite policy: unlink the superseded file after the new one is durable.
  if (prior && prior.filename && prior.filename !== filename) {
    await unlinkFile(snapshotPath(prior.filename));
  }
  console.log(
    `${LOG} chat=${short(chatId)} parked slot=${lease.slotId} tokens=${nSaved ?? lastUsage} bytes=${nWritten ?? estimate} ms=${saveMs ?? "n/a"}`,
  );
}

function upsertSaving(
  chatId: string,
  lease: LlamaSlotLease,
  filename: string,
  lastUsage: number,
  now: number,
  prior: KvSnapshotRow | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO kv_snapshots
         (chat_id, pool_key, base_url, model_id, slot_id, filename, n_tokens, bytes,
          prefix_digest, build_tag, config_digest, state, saved_at, last_used_at,
          restore_count, miss_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '', 'saving', ?, ?, 0, 0)
       ON CONFLICT(chat_id) DO UPDATE SET
         pool_key = excluded.pool_key,
         base_url = excluded.base_url,
         model_id = excluded.model_id,
         slot_id = excluded.slot_id,
         filename = excluded.filename,
         n_tokens = excluded.n_tokens,
         bytes = kv_snapshots.bytes,
         state = 'saving',
         saved_at = excluded.saved_at,
         last_used_at = excluded.last_used_at`,
    )
    .run(
      chatId,
      lease.poolKey,
      lease.baseUrl,
      lease.modelId,
      lease.slotId,
      filename,
      lastUsage,
      prior?.bytes ?? 0,
      now,
      now,
    );
}

function rollbackToPrior(chatId: string, prior: KvSnapshotRow | null): void {
  if (prior && prior.state === "ready") {
    restorePriorRow(chatId, prior);
    return;
  }
  setState(chatId, "stale");
}

function restorePriorRow(chatId: string, prior: KvSnapshotRow): void {
  getDb()
    .prepare("UPDATE kv_snapshots SET filename = ?, n_tokens = ?, bytes = ?, state = 'ready' WHERE chat_id = ?")
    .run(prior.filename, prior.nTokens, prior.bytes, chatId);
}

function setState(chatId: string, state: KvSnapshotState): void {
  getDb().prepare("UPDATE kv_snapshots SET state = ? WHERE chat_id = ?").run(state, chatId);
}

// ---------------------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------------------

interface SlotCallResult {
  ok: boolean;
  error?: string;
  nSaved?: number;
  nWritten?: number;
  saveMs?: number;
}

async function callSlotAction(
  lease: LlamaSlotLease,
  action: "save",
  filename: string,
  timeoutMs: number,
): Promise<SlotCallResult> {
  try {
    const response = await fetch(`${lease.baseUrl}/slots/${lease.slotId}?action=${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }), // §2.2: key is `filename`, not `prompt`
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body: any = await response.json().catch(() => null);
    if (!response.ok || !body || body.error) {
      return { ok: false, error: body?.error?.message || `HTTP ${response.status}` };
    }
    return {
      ok: true,
      nSaved: typeof body.n_saved === "number" ? body.n_saved : undefined,
      nWritten: typeof body.n_written === "number" ? body.n_written : undefined,
      saveMs: body?.timings?.save_ms,
    };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/** Best-effort build tag from the native /server_info endpoint (Phase 3's
 *  invalidation compares this against the live value before restoring). */
async function probeBuildTag(baseUrl: string): Promise<string> {
  try {
    const response = await fetch(`${baseUrl}/server_info`, { signal: AbortSignal.timeout(5_000) });
    const body: any = await response.json().catch(() => null);
    if (!response.ok || !body) return "";
    return String(body.build_number ? `b${body.build_number}` : body.version || "").trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Budget: estimates, LRU eviction, disk headroom (doc §5.5)
// ---------------------------------------------------------------------------

/** Fallback bytes-per-token used only until the first real measurement. Kept
 *  deliberately generous: the estimate gates a headroom CHECK, not the write
 *  itself, so overestimating only ever skips a save. */
const FALLBACK_BYTES_PER_TOKEN = 96 * 1024;

function snapshotPath(filename: string): string {
  // Filenames are generated from server-owned UUIDs + timestamps; reject
  // anything else so registry corruption can never become path injection.
  if (!/^[A-Za-z0-9._-]+\.bin$/.test(filename)) {
    throw new Error(`${LOG} rejected unsafe snapshot filename`);
  }
  return `${KV_CACHE_DIR}/${filename}`;
}

function estimateBytes(chatId: string, poolKey: string, nTokens: number): number {
  const database = getDb();
  const own = database
    .prepare("SELECT bytes, n_tokens FROM kv_snapshots WHERE chat_id = ? AND bytes > 0")
    .get(chatId) as { bytes: number; n_tokens: number } | undefined;
  const measured =
    own && own.n_tokens > 0
      ? own.bytes / own.n_tokens
      : (() => {
          const peer = database
            .prepare(
              "SELECT bytes, n_tokens FROM kv_snapshots WHERE pool_key = ? AND bytes > 0 AND n_tokens > 0 ORDER BY last_used_at DESC LIMIT 1",
            )
            .get(poolKey) as { bytes: number; n_tokens: number } | undefined;
          return peer ? peer.bytes / peer.n_tokens : null;
        })();
  return Math.ceil(nTokens * (measured ?? FALLBACK_BYTES_PER_TOKEN));
}

function evictPoolToBudget(
  poolKey: string,
  estimate: number,
  keepChatId: string,
  policy: KvSnapshotSettings,
): void {
  const database = getDb();
  const rows = database
    .prepare(
      "SELECT chat_id, filename, bytes FROM kv_snapshots WHERE pool_key = ? AND state = 'ready' AND chat_id != ? ORDER BY last_used_at ASC",
    )
    .all(poolKey, keepChatId) as Array<{ chat_id: string; filename: string; bytes: number }>;
  let poolBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  for (const row of rows) {
    if (poolBytes + estimate <= policy.maxBytesPerPool) break;
    poolBytes -= row.bytes;
    if (row.filename) void unlinkFile(snapshotPath(row.filename));
    database.prepare("DELETE FROM kv_snapshots WHERE chat_id = ?").run(row.chat_id);
    console.log(`${LOG} LRU-evicted chat=${short(row.chat_id)} to make room`);
  }
}

async function freeDiskBytes(): Promise<number | null> {
  try {
    const stats = await statfs(KV_CACHE_DIR);
    return stats.bavail * stats.bsize;
  } catch (error: any) {
    console.warn(`${LOG} statfs failed:`, error?.message || error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pruning (doc §5.5): TTL, stale expiry, pool cap, orphan files
// ---------------------------------------------------------------------------

export interface KvSnapshotPruneReport {
  expired: number;
  staleRemoved: number;
  missingFile: number;
  orphansUnlinked: number;
}

export async function pruneKvSnapshots(): Promise<KvSnapshotPruneReport> {
  const report: KvSnapshotPruneReport = { expired: 0, staleRemoved: 0, missingFile: 0, orphansUnlinked: 0 };
  try {
    const settings = await readSettings();
    const policy = resolveKvSnapshotSettings(settings);
    const database = getDb();
    const now = Date.now();
    const ttlMs = policy.ttlHours * 60 * 60 * 1000;

    // Jobs that never finalized (crash during save) — rescue rows whose
    // `saving` claim is older than the op budget.
    database
      .prepare("UPDATE kv_snapshots SET state = 'stale' WHERE state IN ('saving', 'restoring') AND saved_at < ?")
      .run(now - policy.opTimeoutMs * 2);

    const rows = database
      .prepare("SELECT chat_id, filename, bytes, state, saved_at FROM kv_snapshots")
      .all() as Array<{ chat_id: string; filename: string; bytes: number; state: string; saved_at: number }>;

    for (const row of rows) {
      try {
        const expired = now - row.saved_at > ttlMs;
        if (expired || row.state === "stale") {
          if (row.filename) await unlinkFile(snapshotPath(row.filename));
          database.prepare("DELETE FROM kv_snapshots WHERE chat_id = ?").run(row.chat_id);
          if (expired) report.expired++;
          else report.staleRemoved++;
          continue;
        }
        if (row.state === "ready" && row.filename) {
          const path = snapshotPath(row.filename);
          try {
            await access(path);
          } catch {
            await unlinkFile(path); // torn/partial artifact, clear it
            database.prepare("UPDATE kv_snapshots SET state = 'stale', filename = '' WHERE chat_id = ?").run(row.chat_id);
            report.missingFile++;
          }
        }
      } catch (error: any) {
        // A poisoned row (e.g. unsafe filename) must not strand the whole sweep.
        console.warn(`${LOG} prune row ${short(row.chat_id)} skipped:`, error?.message || error);
      }
    }

    // Pool cap enforcement (save-time eviction is best-effort; this is the
    // authority when settings changed or saves raced the budget).
    const pools = database
      .prepare("SELECT DISTINCT pool_key FROM kv_snapshots WHERE state = 'ready'")
      .all() as Array<{ pool_key: string }>;
    for (const { pool_key } of pools) {
      evictPoolToBudget(pool_key, 0, "", policy);
    }

    // Orphan files: anything in the directory not referenced by a row.
    const referenced = new Set(
      (database.prepare("SELECT filename FROM kv_snapshots WHERE filename != ''").all() as Array<{ filename: string }>).map(
        (r) => r.filename,
      ),
    );
    try {
      const entries = await readdir(KV_CACHE_DIR);
      for (const entry of entries) {
        if (entry.endsWith(".bin") && !referenced.has(entry)) {
          await unlinkFile(`${KV_CACHE_DIR}/${entry}`);
          report.orphansUnlinked++;
        }
      }
    } catch {
      // Directory may legitimately not exist on hosts that never parked.
    }

    if (report.expired || report.staleRemoved || report.missingFile || report.orphansUnlinked) {
      console.log(`${LOG} prune: expired=${report.expired} stale=${report.staleRemoved} missing=${report.missingFile} orphans=${report.orphansUnlinked}`);
    }
    return report;
  } catch (error: any) {
    console.warn(`${LOG} prune failed:`, error?.message || error);
    return report;
  }
}

// ---------------------------------------------------------------------------
// Invalidation (doc §5.5): compaction, deletion, pending-save cancel
// ---------------------------------------------------------------------------

/**
 * Drop the chat's snapshot and its file. Called when the message spine is
 * rewritten (compaction), the chat is deleted, or the row would otherwise be
 * misleading. Also supersedes any queued-but-unrun save job.
 */
export async function invalidateKvSnapshot(chatId: string, reason: string): Promise<void> {
  try {
    pendingTokens.set(chatId, (pendingTokens.get(chatId) ?? 0) + 1);
    const database = getDb();
    const row = database
      .prepare("SELECT filename FROM kv_snapshots WHERE chat_id = ?")
      .get(chatId) as { filename: string } | undefined;
    database.prepare("DELETE FROM kv_snapshots WHERE chat_id = ?").run(chatId);
    if (row?.filename) {
      await unlinkFile(snapshotPath(row.filename));
    }
    console.log(`${LOG} invalidated chat=${short(chatId)} reason=${reason}`);
  } catch (error: any) {
    console.warn(`${LOG} invalidate failed (chat=${short(chatId)}, ${reason}):`, error?.message || error);
  }
}

async function unlinkFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.warn(`${LOG} unlink failed (${path}):`, error?.message || error);
    }
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}

function formatGiB(bytes: number | null): string {
  if (bytes === null) return "unknown";
  return `${(bytes / GIB).toFixed(1)} GiB`;
}
