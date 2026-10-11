import Database from "better-sqlite3";
import { createHash } from "crypto";
import { access, readdir, statfs, unlink } from "fs/promises";
import { appDataPath, KV_CACHE_DIR } from "./paths.js";
import type { LlamaSlotLease } from "./llama-slot-leases.js";
import { liveStreams } from "./live-streams.js";
import { onLlmRequestEvent } from "./request-log.js";
import { resolveLlamaBuildTag } from "./llama-build-probe.js";

/**
 * KV snapshot parking — Phases 1–3 (registry, save policy, restore gate) of
 * docs/design/kv-snapshot-parking.md.
 *
 * At end of turn, chats whose context outgrows llama.cpp's RAM prompt cache are
 * parked to NVMe via `POST /slots/{id}?action=save`, so a later cold return can
 * restore (~seconds) instead of re-prefilling (~minutes at 200 tok/s). The
 * feature sits behind `kvSnapshotEnabled` (off by default, D8).
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
 * - Tier-1 warmth is read from the SERVER, not app memory: the pre-send gate
 *   probes the pinned slot's `n_prompt_tokens` (GET /slots) instead of trusting
 *   the residency record, whose warm memory outlives llama.cpp's idle-slot
 *   eviction by orders of magnitude (10-11 review fix).
 * - Build identity comes from the running binary (`/proc/<pid>/exe` +
 *   `--version` via llama-build-probe); `/server_info` is not a stable endpoint
 *   (absent on b11552). Wire-level restore failures count as breaker strikes
 *   so a persistently bad file stops after two attempts (10-11 review fix).
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
  minBuild: number;
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
  // Conservative: the first build verified end-to-end for parking (spike
  // 10-11). Lower it deliberately once #26640/#26004 build numbers are pinned.
  minBuild: 11_552,
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
    minBuild: positiveOr(settings?.kvSnapshotMinBuild, KV_SNAPSHOT_DEFAULTS.minBuild),
  };
}

/** Extract the numeric build from a tag like `b11552-23b0202a1` or `b11552`. */
function buildNumberFromTag(tag: string): number | null {
  const match = /^b(\d+)/.exec(tag);
  return match ? Number(match[1]) : null;
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

// ---------------------------------------------------------------------------
// Restore gate (doc §5.4) — provider-side observation, pre-iteration-1
// ---------------------------------------------------------------------------

/**
 * Stable-prefix digest as observed on the WIRE (§5.2, landed refinement):
 * the sha256 of [system head, tool surface] from the exact body llama.cpp
 * will tokenize. The head is the frozen prefix by Porrima's construction
 * (memory deltas ride at the tail), so it changes exactly when the parked KV
 * stops matching — persona/extract prompt rewrites, tool-surface changes,
 * compaction. It gates WASTED restores only; correctness never depends on it
 * (§2.9: the server validates token identity and re-prefills from the first
 * divergence).
 */
export function computeLlamaPrefixDigest(body: any): string {
  const head = body?.system ?? body?.messages?.[0] ?? null;
  return createHash("sha256")
    .update(JSON.stringify([head ?? null, body?.tools ?? null]))
    .digest("hex");
}

/** Latest wire-head digest per chat, observed by the provider on every
 *  recorded turn request. Stamped into the row at park time. */
const turnPrefixDigests = new Map<string, string>();
/** One restore attempt per (chat, turn): turnId-keyed, mid-turn compaction
 *  stream resets cannot re-arm it. */
const restoreAttemptTurns = new Map<string, string>();
/** Restore markers awaiting iteration-1 usage confirmation (breaker input). */
const pendingRestoreValidation = new Map<string, { chatId: string; turnId?: string; restoredTokens: number }>();

const BUILD_TAG_TTL_MS = 60_000;
const buildTagCache = new Map<string, { tag: string; at: number }>();

async function cachedBuildTag(baseUrl: string): Promise<string> {
  const hit = buildTagCache.get(baseUrl);
  if (hit && Date.now() - hit.at < BUILD_TAG_TTL_MS) return hit.tag;
  // The running binary is the authoritative source (llama-build-probe):
  // /proc/<pid>/exe + `<bin> --version`. /server_info is not a stable
  // endpoint (absent on b11552) and is only a legacy fallback there.
  const tag = await resolveLlamaBuildTag(baseUrl);
  if (tag) buildTagCache.set(baseUrl, { tag, at: Date.now() });
  return tag;
}

/**
 * Single provider-side observation point, called before EVERY dispatched
 * turn request: records the wire-head digest, and on iteration 1 of a
 * lease-pinned request, gates and (if warranted) performs the pre-send
 * restore. Total by contract — must never throw toward the dispatch.
 */
export async function observeLlamaRequestBody(input: {
  chatId: string;
  lease: LlamaSlotLease;
  body: any;
  turnId?: string;
  iteration: number;
}): Promise<void> {
  try {
    const digest = computeLlamaPrefixDigest(input.body);
    turnPrefixDigests.set(input.chatId, digest);
    if (input.iteration !== 1) return; // restore is a start-of-turn operation

    const settings = await readSettings();
    const policy = resolveKvSnapshotSettings(settings);
    if (!policy.enabled) return;

    // One attempt per turn.
    if (input.turnId && restoreAttemptTurns.get(input.chatId) === input.turnId) return;
    if (input.turnId) restoreAttemptTurns.set(input.chatId, input.turnId);

    const row = getKvSnapshot(input.chatId);
    if (!row || row.state !== "ready" || !row.filename) return;
    if (row.poolKey !== input.lease.poolKey) return; // chat moved pools

    // Breaker (§5.4 step 5): confirmed-miss restores stop until a re-park.
    if (row.missCount >= 2) {
      console.log(`${LOG} chat=${short(input.chatId)} restore skipped: breaker (${row.missCount} misses)`);
      return;
    }

    // Digest gate: head drift makes the restore worthless — skip, don't
    // invalidate; the row's file stays valid for its own stored prefix.
    if (row.prefixDigest && row.prefixDigest !== digest) {
      console.log(`${LOG} chat=${short(input.chatId)} restore skipped: prefix digest drift`);
      return;
    }

    // Build gate (§2.7/D5): files are only valid for the build that wrote
    // them. A known mismatch invalidates; unknown-on-either-side is allowed
    // through (llama.cpp's own version checks in the save file are the
    // backstop, and a failure there is just a cold turn, as today).
    const live = await cachedBuildTag(input.lease.baseUrl);
    if (row.buildTag && live && row.buildTag !== live) {
      console.log(
        `${LOG} chat=${short(input.chatId)} snapshot invalidated: build ${row.buildTag} -> ${live}`,
      );
      setState(input.chatId, "stale");
      return;
    }

    // Tier-1 gate (§5.4 step 2): ask the server what the pinned slot
    // actually holds. The app-side residency record is memory with a 12h
    // horizon while llama.cpp evicts idle slot KV in minutes, so it is not
    // a reliable "warm" witness — the slot is. If the slot still holds most
    // of the parked prefix, tier 1 will serve the turn; tier 2 must not
    // pay the restore. Probe failure is a skip (never a guess): the turn
    // proceeds with normal prefill, no state change.
    const tier1Tokens = await slotPromptTokens(input.lease);
    if (tier1Tokens === null) {
      console.warn(`${LOG} chat=${short(input.chatId)} restore skipped: slot probe failed`);
      return;
    }
    const warmThreshold = Math.ceil(row.nTokens * 0.5);
    if (tier1Tokens >= warmThreshold) {
      return;
    }

    const restore = await callSlotAction(input.lease, "restore", row.filename, policy.opTimeoutMs);
    if (!restore.ok) {
      // A wire-level failure (build/config-incompatible file, torn write,
      // server error) is evidence the park is not hitting — count it as a
      // strike so a persistently bad file stops after two attempts instead
      // of retrying forever. A successful re-park resets the count.
      const strikes = row.missCount + 1;
      getDb()
        .prepare("UPDATE kv_snapshots SET miss_count = ? WHERE chat_id = ?")
        .run(Math.min(strikes, 99), input.chatId);
      console.warn(
        `${LOG} chat=${short(input.chatId)} restore failed (wire): ${restore.error} — strike ${strikes}`,
      );
      return;
    }
    getDb()
      .prepare("UPDATE kv_snapshots SET last_used_at = ?, restore_count = restore_count + 1 WHERE chat_id = ?")
      .run(Date.now(), input.chatId);
    pendingRestoreValidation.set(
      `${input.chatId}:${input.turnId ?? ""}`,
      { chatId: input.chatId, turnId: input.turnId, restoredTokens: restore.nTokens ?? row.nTokens },
    );
    console.log(
      `${LOG} chat=${short(input.chatId)} restored slot=${input.lease.slotId} tokens=${restore.nTokens ?? row.nTokens} ms=${restore.ms ?? "n/a"}`,
    );
  } catch (error: any) {
    console.warn(`${LOG} request observation failed:`, error?.message || error);
  }
}

/**
 * Breaker input (§5.4 step 5): iteration-1 usage of a turn that began with a
 * restore confirms whether the parked KV actually hit. Wire-truth
 * cached_tokens/prompt_tokens >= 0.5 counts as a hit (partial prefixes still
 * save most of the prefill and are not the breaker's problem); anything
 * below marks the park as ineffective for this chat. A re-park resets the
 * count (see the save success path).
 */
export function validateRestoreFromUsage(input: {
  chatId: string;
  turnId?: string;
  promptTokens?: number | null;
  cachedTokens?: number | null;
}): void {
  const key = `${input.chatId}:${input.turnId ?? ""}`;
  const pending = pendingRestoreValidation.get(key);
  if (!pending) return;
  pendingRestoreValidation.delete(key);

  const prompt = input.promptTokens ?? 0;
  const cached = input.cachedTokens ?? 0;
  const row = getKvSnapshot(input.chatId);
  if (!row) return;

  if (prompt > 0 && cached / prompt >= 0.5) {
    if (row.missCount > 0) {
      getDb().prepare("UPDATE kv_snapshots SET miss_count = 0 WHERE chat_id = ?").run(input.chatId);
    }
    console.log(
      `${LOG} chat=${short(input.chatId)} restore confirmed: cached ${cached}/${prompt}`,
    );
    return;
  }
  getDb()
    .prepare("UPDATE kv_snapshots SET miss_count = miss_count + 1 WHERE chat_id = ?")
    .run(input.chatId);
  console.warn(
    `${LOG} chat=${short(input.chatId)} restore missed: cached ${cached}/${prompt} (miss=${row.missCount + 1})`,
  );
}

let requestEventsWired = false;

/** Open the registry, run the startup sweep, wire restore-usage validation.
 *  Idempotent; called from index.ts. */
export function initializeKvSnapshotStore(): void {
  getDb();
  if (!requestEventsWired) {
    requestEventsWired = true;
    // The request-log end events carry wire-truth usage (D7) — the breaker's
    // only honest input. Listener failures are contained by the emitter.
    onLlmRequestEvent((event) => {
      if (event.type === "end" && event.iteration === 1 && event.status === "done") {
        try {
          validateRestoreFromUsage({
            chatId: event.chatId,
            turnId: event.turnId,
            promptTokens: event.promptTokens,
            cachedTokens: event.cachedTokens,
          });
        } catch (error: any) {
          console.warn(`${LOG} usage validation failed:`, error?.message || error);
        }
      }
    });
  }
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

  // Build gate (doc §6 minimum-build): run BEFORE touching the registry so
  // an ineligible server leaves no row changes at all. A known build below
  // the parking minimum (its saves lack #26640/#26004 support) is skipped
  // with a visible reason; an unknown build passes (llama.cpp's own file
  // checks are the backstop).
  const buildTag = await cachedBuildTag(lease.baseUrl);
  const liveBuild = buildNumberFromTag(buildTag);
  if (liveBuild != null && liveBuild < policy.minBuild) {
    console.warn(
      `${LOG} chat=${short(chatId)} parking disabled: server build ${buildTag} is below the parking minimum b${policy.minBuild}`,
    );
    return;
  }

  // Budget gate: pool LRU eviction first, then absolute disk headroom. The
  // estimate reads the chat's own prior bytes/n_tokens ratio — this MUST
  // happen before upsertSaving, which rewrites n_tokens in place (reading
  // after would compute prior.bytes / lastUsage, an under-estimate whenever
  // the context grew).
  const estimate = estimateBytes(chatId, lease.poolKey, lastUsage);

  // Claim the slot row in `saving`; keep the previous filename so a failed
  // save can roll the row back to whatever was actually true on disk.
  upsertSaving(chatId, lease, filename, lastUsage, now, prior);

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

  // Slot-identity guard: the save fired AFTER this chat's lease released, so
  // a new turn may have acquired the same slot and started filling it before
  // the write landed. The slot can never hold fewer tokens than the finished
  // turn's prompt — a shortfall means the file captured someone else's
  // state. Discard it and keep the prior snapshot instead of unlinking a
  // good file under an alias for a bad one.
  if (save.nTokens != null && save.nTokens < lastUsage) {
    await unlinkFile(snapshotPath(filename));
    rollbackToPrior(chatId, prior);
    console.warn(
      `${LOG} chat=${short(chatId)} discarded save: n_saved=${save.nTokens} < finished-turn prompt=${lastUsage} (slot reassigned mid-save)`,
    );
    return;
  }

  const parkedTokens = save.nTokens ?? lastUsage;
  const parkedBytes = save.nBytes ?? estimate;
  const database = getDb();
  // A successful park resets the restore breaker (§5.4 step 5): the parked
  // state is fresh evidence that a restore can hit. The observed wire-head
  // digest of this turn rides along for the Phase 3 restore gate (§5.2).
  database
    .prepare(
      `UPDATE kv_snapshots
         SET filename = ?, n_tokens = ?, bytes = ?, build_tag = ?, prefix_digest = ?,
             state = 'ready', saved_at = ?, last_used_at = ?, miss_count = 0
       WHERE chat_id = ?`,
    )
    .run(
      filename,
      parkedTokens,
      parkedBytes,
      buildTag,
      turnPrefixDigests.get(chatId) ?? "",
      Date.now(),
      Date.now(),
      chatId,
    );

  // Overwrite policy: unlink the superseded file after the new one is durable.
  if (prior && prior.filename && prior.filename !== filename) {
    await unlinkFile(snapshotPath(prior.filename));
  }
  console.log(
    `${LOG} chat=${short(chatId)} parked slot=${lease.slotId} tokens=${parkedTokens} bytes=${parkedBytes} ms=${save.ms ?? "n/a"}`,
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
  nTokens?: number;
  nBytes?: number;
  ms?: number;
}

async function callSlotAction(
  lease: LlamaSlotLease,
  action: "save" | "restore",
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
    const number = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
    // Save and restore report the same triple under different keys (§2.2).
    const timings = body?.timings ?? {};
    return {
      ok: true,
      nTokens: number(body.n_saved) ?? number(body.n_restored),
      nBytes: number(body.n_written) ?? number(body.n_read),
      ms: number(timings.save_ms) ?? number(timings.restore_ms),
    };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Tier-1 probe: how many prompt tokens the pinned slot currently holds
 * (doc §5.4 step 2, landed 10-11 review fix). The app-side residency
 * record is memory with a 12h horizon while llama.cpp evicts idle slot
 * KV in minutes — the slot itself is the only pre-send signal that is
 * ground truth. `null` means the probe failed (caller must skip the
 * restore, not guess); an absent slot or zero count means cold.
 */
const SLOT_PROBE_TIMEOUT_MS = 5_000;

async function slotPromptTokens(lease: LlamaSlotLease): Promise<number | null> {
  try {
    const response = await fetch(`${lease.baseUrl}/slots`, {
      signal: AbortSignal.timeout(SLOT_PROBE_TIMEOUT_MS),
    });
    const body: any = await response.json().catch(() => null);
    const slots = Array.isArray(body) ? body : Array.isArray(body?.slots) ? body.slots : null;
    if (!slots) return null;
    const slot = slots.find((s: any) => s?.id === lease.slotId);
    if (!slot) return 0;
    return typeof slot.n_prompt_tokens === "number" ? slot.n_prompt_tokens : 0;
  } catch {
    return null;
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
// Surfaces (Phase 4): summary for the status panel / settings display
// ---------------------------------------------------------------------------

export interface KvSnapshotPoolTotals {
  poolKey: string;
  baseUrl: string;
  modelId: string;
  count: number;
  bytes: number;
}

export interface KvSnapshotSummary {
  enabled: boolean;
  policy: KvSnapshotSettings;
  snapshots: KvSnapshotRow[];
  pools: KvSnapshotPoolTotals[];
  freeDiskBytes: number | null;
}

export async function getKvSnapshotSummary(): Promise<KvSnapshotSummary> {
  const settings = await readSettings();
  const policy = resolveKvSnapshotSettings(settings);
  const snapshots = listKvSnapshots();
  const byPool = new Map<string, KvSnapshotPoolTotals>();
  for (const row of snapshots) {
    const totals = byPool.get(row.poolKey) ?? {
      poolKey: row.poolKey,
      baseUrl: row.baseUrl,
      modelId: row.modelId,
      count: 0,
      bytes: 0,
    };
    totals.count += 1;
    totals.bytes += row.bytes;
    byPool.set(row.poolKey, totals);
  }
  return {
    enabled: policy.enabled,
    policy,
    snapshots,
    pools: [...byPool.values()],
    freeDiskBytes: await freeDiskBytes(),
  };
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
    turnPrefixDigests.delete(chatId);
    restoreAttemptTurns.delete(chatId);
    for (const key of [...pendingRestoreValidation.keys()]) {
      if (key.startsWith(`${chatId}:`)) pendingRestoreValidation.delete(key);
    }
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
