import Database from "better-sqlite3";
import { createHash } from "crypto";
import { access, readdir, statfs, unlink } from "fs/promises";
import { appDataPath, KV_CACHE_DIR } from "./paths.js";
import type { LlamaSlotLease } from "./llama-slot-leases.js";
import { liveStreams } from "./live-streams.js";
import { onLlmRequestEvent } from "./request-log.js";
import { resolveLlamaBuildTag } from "./llama-build-probe.js";
import { getInferenceBackend, resolveInferenceBaseUrl, strataAuthHeaders } from "./inference-backend.js";

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
 *   eviction by orders of magnitude (10-11 review fix). The count is only a
 *   residency witness for the slot's LAST WRITER: the app records who last
 *   left state in each (poolKey, slot), and a restore targeting a slot whose
 *   last writer is another chat treats the slot as cold — its count measures
 *   the other chat's fill, not this prefix's residency (single-slot launch
 *   makes every slot shared; doc §7 D9).
 * - A park captures what the slot holds, and the slot holds the state the last
 *   DONE chat request left there (D7). When a spine rewrite (compaction)
 *   invalidates the snapshot after that request, the slot still holds exactly
 *   the wire shape the rewrite made obsolete — parking it now would re-register
 *   the invalidation as a `ready` row and burn the slot queue + tens of GB on a
 *   capture that can only ever miss (the wire-head digest CANNOT catch this:
 *   compaction rewrites the messages, not [system, tools], so the head digest
 *   is identical pre/post rewrite — eager invalidation is the only spine
 *   witness). §5.3 suppresses such parks at enqueue and again at completion.
 * - Build identity comes from the running binary (`/proc/<pid>/exe` +
 *   `--version` via llama-build-probe); `/server_info` is not a stable endpoint
 *   (absent on b11552). Wire-level restore failures count as breaker strikes
 *   so a persistently bad file stops after two attempts (10-11 review fix).
 * - A parking target is one physical slot on one server. Two ways to name
 *   one: a lease (llama.cpp, enforced binding) or a fixed slot 0 on a
 *   single-slot server (Strata today; first-class llama.cpp single-slot is
 *   the intended efficient path there and reuses the same fixed-slot
 *   transport). The policy in this file is backend-agnostic; only the
 *   transport calls below branch on backend (docs/design/strata-backend.md §7).
 * - Slot files are opaque per server: never portable across backends. A
 *   target change (baseUrl, model, or backend) flows through pool-key and
 *   build-identity mismatches and drops the row like any stale snapshot.
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
 * stops matching — persona regeneration, extraction prompt edits,
 * tool-surface changes. **Not compaction**: compaction rewrites the messages,
 * never the head, so the digest gate is blind to it — §5.5 eager invalidation
 * plus the §5.3 spine-freshness gate carry that case. It gates WASTED
 * restores only; correctness never depends on it (§2.9: the server validates
 * token identity and re-prefills from the first divergence).
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

// ---------------------------------------------------------------------------
// Parking targets (docs/design/strata-backend.md §7)
// ---------------------------------------------------------------------------

/**
 * One physical slot on one server, named by a lease or fixed. The policy
 * layer treats every target identically; only the transport calls and the
 * identity probe below branch on `backend`.
 */
interface ParkingTarget {
  baseUrl: string;
  slotId: number;
  /** Registry pool identity: the lease's pool key, or its fixed-target
   *  equivalent. Registry rows compare it to detect a moved pool. */
  poolKey: string;
  modelId: string;
  backend: "llamacpp" | "strata";
  /** Attached to every transport call (Strata guards /slots and /props). */
  authHeaders?: Record<string, string>;
  /** Directory the server writes slot files to; Porrima unlinks from here.
   *  Defaults to the shared KV cache dir — the documented setup points a
   *  single-slot server's save path there. */
  saveDir: string;
  /** Row stamp written to config_digest when saveDir is non-default, so
   *  later unlink passes find the file. Empty on the default layout. */
  configDigest: string;
}

function normalizeTargetUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Resolve the parking target for a turn or warm. A lease always wins.
 * Without one, only single-slot backends get a fixed target — llama.cpp
 * keeps the D2 rule (no lease, no pinning) until single-slot operation
 * lands there as a first-class config. Synchronous by contract: the park
 * entry points must reach their slot-queue writes with the same await
 * ordering as the pre-target code, or restore-side save cancellation races
 * enqueue (shared-slot §7 D9).
 */
function parkingTarget(
  lease: LlamaSlotLease | null | undefined,
  settings: any,
): ParkingTarget | null {
  if (lease) {
    return {
      baseUrl: lease.baseUrl,
      slotId: lease.slotId,
      poolKey: lease.poolKey,
      modelId: lease.modelId,
      backend: "llamacpp",
      saveDir: KV_CACHE_DIR,
      configDigest: "",
    };
  }
  if (getInferenceBackend(settings ?? {}) !== "strata") return null;
  const baseUrl = normalizeTargetUrl(resolveInferenceBaseUrl(settings));
  const modelId =
    typeof settings.defaultModelId === "string" && settings.defaultModelId
      ? settings.defaultModelId
      : "strata";
  const saveDir =
    (typeof settings.strataSlotSavePath === "string" && settings.strataSlotSavePath.trim()) ||
    KV_CACHE_DIR;
  return {
    baseUrl,
    slotId: 0,
    poolKey: JSON.stringify([baseUrl, modelId, null]),
    modelId,
    backend: "strata",
    authHeaders: strataAuthHeaders(settings),
    saveDir,
    configDigest: saveDir === KV_CACHE_DIR ? "" : JSON.stringify({ saveDir }),
  };
}

/** BaseUrl → the "why parking is off" note, from a 501 on a slot action:
 *  the server launched without a slot save path, or with batch slots (where
 *  save/restore is refused). Cleared when the identity changes (the server
 *  config behind the URL moved) — TTL like the build tag. */
const parkingUnsupported = new Map<string, { reason: string; at: number }>();
const UNSUPPORTED_TTL_MS = 10 * 60 * 1000;

function unsupportedNote(baseUrl: string): string | null {
  const hit = parkingUnsupported.get(baseUrl);
  if (!hit) return null;
  if (Date.now() - hit.at > UNSUPPORTED_TTL_MS) {
    parkingUnsupported.delete(baseUrl);
    return null;
  }
  return hit.reason;
}

function markParkingUnsupported(baseUrl: string, reason: string): void {
  parkingUnsupported.set(baseUrl, { reason, at: Date.now() });
}

/** Server identity for the build gate. llama.cpp: the running binary
 *  (/proc/<pid>/exe + --version, via llama-build-probe; /server_info is not
 *  a stable endpoint and only a legacy fallback there). Strata: /props
 *  build_info + model_path — the engine also fingerprints every session
 *  file against model and config itself, so a stale file fails at restore
 *  and costs a breaker strike rather than silently corrupting state. */
async function cachedTargetIdentity(target: ParkingTarget): Promise<string> {
  const hit = buildTagCache.get(target.baseUrl);
  if (hit && Date.now() - hit.at < BUILD_TAG_TTL_MS) return hit.tag;
  let tag = "";
  if (target.backend === "strata") {
    try {
      const res = await fetch(`${target.baseUrl}/props`, {
        signal: AbortSignal.timeout(SLOT_PROBE_TIMEOUT_MS),
        headers: target.authHeaders,
      });
      if (res.ok) {
        const props: any = await res.json().catch(() => null);
        if (props) tag = `${props.build_info ?? "?"}|${props.model_path ?? props.model_alias ?? "?"}`;
      }
    } catch {
      // Unknown identity is allowed through (same rule as an unknown build).
    }
  } else {
    tag = await resolveLlamaBuildTag(target.baseUrl);
  }
  if (tag) buildTagCache.set(target.baseUrl, { tag, at: Date.now() });
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
  /** Lease-pinned turn on llama.cpp; null for a fixed single-slot target
   *  (Strata — docs/design/strata-backend.md §7). */
  lease: LlamaSlotLease | null;
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

    const target = parkingTarget(input.lease, settings);
    if (!target) return;
    const unsupported = unsupportedNote(target.baseUrl);
    if (unsupported) {
      console.log(`${LOG} chat=${short(input.chatId)} restore skipped: parking unsupported (${unsupported})`);
      return;
    }

    // One attempt per turn.
    if (input.turnId && restoreAttemptTurns.get(input.chatId) === input.turnId) return;
    if (input.turnId) restoreAttemptTurns.set(input.chatId, input.turnId);

    const row = getKvSnapshot(input.chatId);
    if (!row || row.state !== "ready" || !row.filename) return;
    if (row.poolKey !== target.poolKey) return; // chat moved pools

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
    const live = await cachedTargetIdentity(target);
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
    // a reliable "warm" witness — the slot is. The slot's token count is
    // only that witness for its LAST WRITER, though: on a shared slot (the
    // single-slot launch, §7 D9) the count measures whoever filled the slot
    // since our park, not whether our parked prefix is resident. When a
    // known different chat last held the slot, treat it as cold and restore.
    // Unknown owner (restart, unpinned activity) keeps the count probe's
    // verdict — degradation to prior behavior, never a guess. Probe failure
    // remains a skip (never a guess): the turn proceeds with normal prefill,
    // no state change.
    const chainKey = slotChainKey(target);
    const owner = slotOwner.get(chainKey);
    if (owner && owner !== input.chatId) {
      console.log(
        `${LOG} chat=${short(input.chatId)} restore: slot=${target.slotId} last held by chat=${short(owner)} — cold for this chat`,
      );
    } else {
      const tier1Tokens = await slotPromptTokens(target);
      if (tier1Tokens === null) {
        console.warn(`${LOG} chat=${short(input.chatId)} restore skipped: slot probe failed`);
        return;
      }
      const warmThreshold = Math.ceil(row.nTokens * 0.5);
      if (tier1Tokens >= warmThreshold) {
        console.log(
          `${LOG} chat=${short(input.chatId)} restore skipped: slot=${target.slotId} still holds ${tier1Tokens}/${row.nTokens} tokens`,
        );
        return;
      }
    }

    // Restore is foreground slot work: it belongs on the slot's serialized
    // chain BEHIND any in-flight save (which captures valid pre-restore
    // state) and AHEAD of other chats' queued saves — those would capture
    // the state this restore lands in the slot and register it under their
    // own row. Cancel them first: bumping the token makes each unstarted
    // job drop itself in runSaveJob's entry check, so the restore's chain
    // wait is one in-flight save, not a save backlog.
    for (const job of queuedSaves.get(chainKey) ?? []) {
      if (job.chatId === input.chatId || job.started) continue;
      if (pendingTokens.get(job.chatId) === job.token) {
        pendingTokens.set(job.chatId, job.token + 1);
      }
    }

    const previous = slotQueues.get(chainKey) ?? Promise.resolve();
    const restoreJob = previous.then(() =>
      callSlotAction(target, "restore", row.filename, policy.opTimeoutMs),
    );
    slotQueues.set(
      chainKey,
      restoreJob.then(
        () => {},
        () => {},
      ),
    );
    const restore = await restoreJob;
    if (!restore.ok) {
      // A 501 is not the file's fault: the server refuses slot actions (no
      // save path configured, or batch slots). Remember it and stop trying.
      if (restore.status === 501) {
        markParkingUnsupported(target.baseUrl, `slot action refused (501): ${restore.error}`);
        console.warn(
          `${LOG} chat=${short(input.chatId)} restore skipped: parking unsupported on ${target.baseUrl}`,
        );
        return;
      }
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
    // The restored state is now this chat's: the slot's residency witness
    // belongs to it again.
    slotOwner.set(chainKey, input.chatId);
    pendingRestoreValidation.set(
      `${input.chatId}:${input.turnId ?? ""}`,
      { chatId: input.chatId, turnId: input.turnId, restoredTokens: restore.nTokens ?? row.nTokens },
    );
    console.log(
      `${LOG} chat=${short(input.chatId)} restored slot=${target.slotId} tokens=${restore.nTokens ?? row.nTokens} ms=${restore.ms ?? "n/a"}`,
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
/** Last spine-rewrite per chat, stamped by `invalidateKvSnapshot` (§5.5).
 *  In-memory like `pendingTokens`: a restart empties the slots, so the
 *  slot-identity guard already bounds the worst case for a lost entry. */
const spineRewrittenAt = new Map<string, number>();
/** Per-slot serialized chains: llama.cpp processes one slot task at a time and
 *  our own queue keeps the registry's view of each slot coherent. SAVES and
 *  RESTORES both run on these chains — with a shared slot (single-slot launch)
 *  an unchained restore can overwrite the state a queued save is about to
 *  capture, registering someone else's KV under the wrong row. */
const slotQueues = new Map<string, Promise<void>>();
/** Queued-save descriptors per slot chain, so a foreground restore can cancel
 *  other chats' QUEUED (not yet started) captures before it replaces the
 *  slot's state. In-flight saves keep their capture: the slot is still the
 *  saving chat's until the restore runs, and the chain orders it first. */
interface QueuedSaveJob {
  chatId: string;
  token: number;
  started: boolean;
}
const queuedSaves = new Map<string, QueuedSaveJob[]>();
/** Last app-known holder of each (poolKey, slotId): whose turn or warm last
 *  left state in the slot. Recorded by both park entry points and by a
 *  successful restore; a different known owner makes the tier-1 count probe
 *  meaningless (§5.4 D9). In-memory like `spineRewrittenAt`: a restart leaves
 *  the owner unknown and the gate falls back to the count probe's verdict —
 *  degradation to prior behavior, never a guess. */
const slotOwner = new Map<string, string>();

function slotChainKey(target: ParkingTarget): string {
  return `${target.poolKey}#${target.slotId}`;
}

/**
 * Enqueue a save job on the slot's serialized chain with a cancelable
 * descriptor. The descriptor is removed when the job settles; a foreground
 * restore bumps the job's token (via `pendingTokens`) so an unstarted job
 * drops itself in `runSaveJob`'s entry check.
 */
function enqueueSaveJob(
  chainKey: string,
  chatId: string,
  token: number,
  run: () => Promise<void>,
): Promise<void> {
  const entry: QueuedSaveJob = { chatId, token, started: false };
  const list = queuedSaves.get(chainKey) ?? [];
  list.push(entry);
  queuedSaves.set(chainKey, list);
  const previous = slotQueues.get(chainKey) ?? Promise.resolve();
  const job = previous
    .then(() => {
      entry.started = true;
      return run();
    })
    .finally(() => {
      const idx = list.indexOf(entry);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) queuedSaves.delete(chainKey);
    });
  slotQueues.set(chainKey, job.catch(() => {}));
  return job;
}

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
    const settings = await readSettings();
    // D2 pinning requirement: the slot must be known — by lease on llama.cpp,
    // fixed at slot 0 on single-slot backends
    // (docs/design/strata-backend.md §7).
    const target = parkingTarget(lease, settings);
    if (!target) return;

    // Slot-ownership witness: this turn (whatever the park gates decide
    // below) left its state in the pinned slot. Recorded before the enabled
    // check so the map stays truthful across a feature toggle.
    slotOwner.set(slotChainKey(target), chatId);

    const policy = resolveKvSnapshotSettings(settings);
    if (!policy.enabled) return;
    if (unsupportedNote(target.baseUrl)) return;

    // Gate: wire-truth prompt size of the most recent DONE request (D7) —
    // the slot holds the state that request left behind. The row's timestamp
    // doubles as the slot-fill witness for the spine-freshness gate below.
    const lastDone = lastDoneChatRequest(chatId);
    if (lastDone == null || lastDone.promptTokens < policy.minTokens) return;

    // Gate: spine freshness (§5.5). An invalidate that landed after the slot's
    // witness request means the slot still holds the PRE-rewrite wire shape —
    // exactly what the invalidation just made obsolete. Parking it would
    // re-register the dropped snapshot as `ready` (a wasted multi-GB write and
    // a guaranteed-miss restore). The next DONE chat request re-fills the slot
    // with the rewritten spine and re-arms eligibility.
    const rewritten = spineRewrittenAt.get(chatId);
    if (rewritten != null && lastDone.timestamp <= rewritten) {
      console.log(
        `${LOG} chat=${short(chatId)} skipped: spine rewritten after the last wire turn (slot holds pre-rewrite state)`,
      );
      return;
    }
    const lastUsage = lastDone.promptTokens;

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

    const chainKey = slotChainKey(target);
    const job = enqueueSaveJob(chainKey, chatId, token, () =>
      runSaveJob({
        chatId,
        target,
        policy,
        token,
        promptTokens: lastUsage,
        streamAtEnqueue,
        existing,
        reason: "end-of-turn",
      }),
    );
    await job;
  } catch (error: any) {
    // Save policy failures are background noise by contract.
    console.warn(`${LOG} end-of-turn parking failed:`, error?.message || error);
  }
}

/**
 * Fire-and-forget post-warm entry point (doc §5.3a): a cache warm has just
 * prefilled a PINNED slot with a freshly built head, so the slot's content
 * is known by construction — the warm is its own witness. This deliberately
 * skips the turn-path gates: there is no `lastDoneChatRequest` witness (the
 * warm never crosses the provider choke point), no spine-freshness
 * comparison to make (a spine rewrite landing mid-save still supersedes the
 * job via the token check, exactly as on the turn path), and no
 * debounce/growth gate (the head-digest comparison replaces it). The row is
 * stamped with the warm's own head digest, not the provider-observed
 * `turnPrefixDigests` — which the warm by definition never populated.
 */
export async function parkAfterWarm(input: {
  chatId: string;
  lease: LlamaSlotLease | null | undefined;
  /**
   * Wire-truth size of the state the slot holds: the warm's (one-token-short)
   * prompt length (`warmTokenCount`). Not the server's workload counters —
   * on a warm-LCP prefill `tokens_cached + tokens_evaluated` double-counts
   * the prompt (10-17 field: expected 136,080 vs slot state 68,040).
   */
  promptTokens: number;
  /** Digest of the warm body's [head, tools] — same computation as the restore gate. */
  prefixDigest: string;
}): Promise<void> {
  try {
    const { chatId, lease } = input;
    const settings = await readSettings();
    const target = parkingTarget(lease, settings);
    if (!target) {
      // D2 pinning requirement: llama.cpp auto binding mode has no pinned slot.
      console.log(`${LOG} chat=${short(chatId)} post-warm park skipped: no parking target`);
      return;
    }

    // Slot-ownership witness: a successful warm prefill leaves the warm's
    // head in the pinned slot, whether or not the park below writes.
    slotOwner.set(slotChainKey(target), chatId);

    const policy = resolveKvSnapshotSettings(settings);
    if (!policy.enabled) {
      console.log(`${LOG} chat=${short(chatId)} post-warm park skipped: feature disabled`);
      return;
    }
    const unsupported = unsupportedNote(target.baseUrl);
    if (unsupported) {
      console.log(`${LOG} chat=${short(chatId)} post-warm park skipped: parking unsupported (${unsupported})`);
      return;
    }

    if (input.promptTokens < policy.minTokens) {
      console.log(
        `${LOG} chat=${short(chatId)} post-warm park skipped: ${input.promptTokens} tokens below min ${policy.minTokens}`,
      );
      return;
    }

    const existing = getKvSnapshot(chatId);

    // Digest-conditional rule: a byte-identical head means the parked file is
    // still valid — the warm only refreshed tier 1. This makes the post-
    // synthesis warm pass the single place where synthesis's effect on the
    // disk tier is handled: changed heads re-park here, unchanged heads skip.
    if (
      existing &&
      existing.state === "ready" &&
      existing.prefixDigest &&
      existing.prefixDigest === input.prefixDigest
    ) {
      console.log(`${LOG} chat=${short(chatId)} post-warm park skipped: head digest unchanged`);
      return;
    }

    const token = (pendingTokens.get(chatId) ?? 0) + 1;
    pendingTokens.set(chatId, token);
    const streamAtEnqueue = liveStreams.get(chatId);

    const chainKey = slotChainKey(target);
    const job = enqueueSaveJob(chainKey, chatId, token, () =>
      runSaveJob({
        chatId,
        target,
        policy,
        token,
        promptTokens: input.promptTokens,
        streamAtEnqueue,
        existing,
        prefixDigest: input.prefixDigest,
        reason: "post-warm",
      }),
    );
    await job;
  } catch (error: any) {
    // Save policy failures are background noise by contract.
    console.warn(`${LOG} post-warm parking failed:`, error?.message || error);
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

/**
 * The chat's most recent DONE wire-truth request (D7) and when it completed.
 * Its `promptTokens` is the park eligibility input; its `timestamp` is the
 * slot-fill witness for the spine-freshness gate: the pinned slot can only be
 * assumed to hold the state THIS request left behind.
 */
function lastDoneChatRequest(chatId: string): { promptTokens: number; timestamp: number } | null {
  const row = getDb()
    .prepare(
      "SELECT prompt_tokens, timestamp FROM llm_requests WHERE chat_id = ? AND status = 'done' AND purpose = 'chat' AND prompt_tokens IS NOT NULL ORDER BY timestamp DESC, iteration DESC LIMIT 1",
    )
    .get(chatId) as { prompt_tokens: number; timestamp: number } | undefined;
  return row ? { promptTokens: row.prompt_tokens, timestamp: row.timestamp } : null;
}

interface SaveJobInput {
  chatId: string;
  target: ParkingTarget;
  policy: KvSnapshotSettings;
  token: number;
  /** Wire-truth size of the state the slot holds: the finished turn's prompt
   *  (turn path) or the warm's one-token-short prompt (post-warm path). */
  promptTokens: number;
  streamAtEnqueue: ReturnType<typeof liveStreams.get>;
  existing: KvSnapshotRow | null;
  /** Explicit head-digest stamp (post-warm path). Omitted on the turn path,
   *  which stamps the provider-observed wire digest at success time. */
  prefixDigest?: string;
  reason: "end-of-turn" | "post-warm";
}

async function runSaveJob(input: SaveJobInput): Promise<void> {
  const { chatId, target, policy, token, promptTokens, streamAtEnqueue, existing, prefixDigest, reason } = input;

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
  const buildTag = await cachedTargetIdentity(target);
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
  const estimate = estimateBytes(chatId, target.poolKey, promptTokens);

  // Claim the slot row in `saving`; keep the previous filename so a failed
  // save can roll the row back to whatever was actually true on disk.
  upsertSaving(chatId, target, filename, promptTokens, now, prior);

  evictPoolToBudget(target.poolKey, estimate, chatId, policy);
  const free = await freeDiskBytes(target.saveDir);
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

  const save = await callSlotAction(target, "save", filename, computeSaveBudgetMs(estimate, policy));

  if (pendingTokens.get(chatId) !== token) {
    // Superseded mid-write: the file we just wrote may be a torn prefix of a
    // longer turn — discard it and let the newer job own the row.
    if (save.ok) await unlinkFile(snapshotPath(filename, target.saveDir));
    rollbackToPrior(chatId, prior);
    return;
  }

  if (!save.ok) {
    console.warn(`${LOG} chat=${short(chatId)} save failed: ${save.error}`);
    // 501 = no slot save path configured (or batch slots). 400 with the
    // invalid category, for a filename we generated ourselves, is a
    // permanent config-level refusal (e.g. Strata's "session files do not
    // support --layer-split"). Both mean the server cannot park: stop
    // attempting for the URL's unsupported window instead of re-failing on
    // every large turn.
    if (save.status === 501 || (save.status === 400 && save.errorKind === "invalid")) {
      markParkingUnsupported(target.baseUrl, `slot action refused (${save.status}): ${save.error}`);
    }
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
  // the write landed. The slot can never hold fewer tokens than the captured
  // prompt — a shortfall means the file captured someone else's state.
  // Discard it and keep the prior snapshot instead of unlinking a good file
  // under an alias for a bad one.
  if (save.nTokens != null && save.nTokens < promptTokens) {
    await unlinkFile(snapshotPath(filename, target.saveDir));
    rollbackToPrior(chatId, prior);
    console.warn(
      `${LOG} chat=${short(chatId)} discarded save: n_saved=${save.nTokens} < captured prompt=${promptTokens} (slot reassigned mid-save)`,
    );
    return;
  }

  // Spine-freshness re-check at completion (the enqueue gate's twin): a
  // rewrite can also land AFTER the witness read above but before this write
  // lands — `invalidateKvSnapshot` supersedes the job via the token check in
  // that ordering, and this is the last gate standing between a `ready` row
  // and a stale capture if any future path reorders those guards. Only a row
  // whose witness request still post-dates the rewrite may be registered.
  const rewritten = spineRewrittenAt.get(chatId);
  if (rewritten != null) {
    const witness = lastDoneChatRequest(chatId);
    if (!witness || witness.timestamp <= rewritten) {
      await unlinkFile(snapshotPath(filename, target.saveDir));
      rollbackToPrior(chatId, prior);
      console.warn(
        `${LOG} chat=${short(chatId)} discarded save: spine rewritten after the last wire turn (captured pre-rewrite slot state)`,
      );
      return;
    }
  }

  const parkedTokens = save.nTokens ?? promptTokens;
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
      prefixDigest ?? turnPrefixDigests.get(chatId) ?? "",
      Date.now(),
      Date.now(),
      chatId,
    );

  // Overwrite policy: unlink the superseded file after the new one is durable.
  if (prior && prior.filename && prior.filename !== filename) {
    await unlinkFile(snapshotPath(prior.filename, rowSaveDir(prior.configDigest)));
  }
  console.log(
    `${LOG} chat=${short(chatId)} parked slot=${target.slotId} tokens=${parkedTokens} bytes=${parkedBytes} ms=${save.ms ?? "n/a"} reason=${reason}`,
  );
}

function upsertSaving(
  chatId: string,
  target: ParkingTarget,
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, 'saving', ?, ?, 0, 0)
       ON CONFLICT(chat_id) DO UPDATE SET
         pool_key = excluded.pool_key,
         base_url = excluded.base_url,
         model_id = excluded.model_id,
         slot_id = excluded.slot_id,
         filename = excluded.filename,
         n_tokens = excluded.n_tokens,
         bytes = kv_snapshots.bytes,
         config_digest = excluded.config_digest,
         state = 'saving',
         saved_at = excluded.saved_at,
         last_used_at = excluded.last_used_at`,
    )
    .run(
      chatId,
      target.poolKey,
      target.baseUrl,
      target.modelId,
      target.slotId,
      filename,
      lastUsage,
      prior?.bytes ?? 0,
      target.configDigest,
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
  /** HTTP status of a wire-level failure (501 = feature unsupported here). */
  status?: number;
  /** Server error category when it provides one (Strata's error.kind:
   *  invalid | memory | storage | io). */
  errorKind?: string;
  nTokens?: number;
  nBytes?: number;
  ms?: number;
}

async function callSlotAction(
  target: ParkingTarget,
  action: "save" | "restore",
  filename: string,
  timeoutMs: number,
): Promise<SlotCallResult> {
  try {
    const response = await fetch(`${target.baseUrl}/slots/${target.slotId}?action=${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(target.authHeaders ?? {}) },
      body: JSON.stringify({ filename }), // §2.2: key is `filename`, not `prompt`
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body: any = await response.json().catch(() => null);
    if (!response.ok || !body || body.error) {
      return {
        ok: false,
        status: response.status,
        errorKind: typeof body?.error?.kind === "string" ? body.error.kind : undefined,
        error: body?.error?.message || `HTTP ${response.status}`,
      };
    }
    const number = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
    // Save and restore report the same triple under different keys (§2.2).
    // Strata's slot-0 API answers these field names unchanged.
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

async function slotPromptTokens(target: ParkingTarget): Promise<number | null> {
  try {
    const response = await fetch(`${target.baseUrl}/slots`, {
      signal: AbortSignal.timeout(SLOT_PROBE_TIMEOUT_MS),
      headers: target.authHeaders,
    });
    const body: any = await response.json().catch(() => null);
    const slots = Array.isArray(body) ? body : Array.isArray(body?.slots) ? body.slots : null;
    if (!slots) return null;
    // Strata answers [] while the engine is unloaded. A restore would 503 and
    // burn a breaker strike against state the server never had a chance to
    // load; skip like a probe failure instead — the turn itself loads the
    // engine, and the next cold return finds the probe warm or empty again.
    if (slots.length === 0 && target.backend === "strata") return null;
    const slot = slots.find((s: any) => s?.id === target.slotId);
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
 *  deliberately generous: the estimate gates a headroom CHECK and the save
 *  budget, so overestimating only ever costs a slower background save or skips
 *  a save. */
const FALLBACK_BYTES_PER_TOKEN = 96 * 1024;

/** Absolute ceiling on a single background save operation. */
const SAVE_BUDGET_MAX_MS = 300_000;

/**
 * Save operations are background work: their budget scales with the state
 * being written. Measured llama.cpp save throughput on this feature line is
 * ≤ ~0.8 GiB/s (18.5 GiB / 24 s at 133k tokens), and a 203k-token save blew
 * the static op budget at 21:48 (10-11) — leaving the next cold return to
 * re-prefill 200k tokens. Reserve `opTimeoutMs` as the floor and add
 * headroom at a conservative 0.5 GiB/s with a 2x factor, capped.
 * RESTORE keeps the plain `opTimeoutMs` — it sits on the user-visible path.
 */
export function computeSaveBudgetMs(estimateBytes: number, policy: KvSnapshotSettings): number {
  const headroomMs = Math.ceil(estimateBytes / (512 * 1024 * 1024)) * 1000 * 2;
  return Math.min(policy.opTimeoutMs + headroomMs, SAVE_BUDGET_MAX_MS);
}

function snapshotPath(filename: string, dir: string = KV_CACHE_DIR): string {
  // Filenames are generated from server-owned UUIDs + timestamps; reject
  // anything else so registry corruption can never become path injection.
  if (!/^[A-Za-z0-9._-]+\.bin$/.test(filename)) {
    throw new Error(`${LOG} rejected unsafe snapshot filename`);
  }
  return `${dir}/${filename}`;
}

/** Save directory recorded on a row (config_digest marker written by
 *  upsertSaving for non-default targets). Rows without a marker — every
 *  llama.cpp row and the default-layout Strata rows — live in KV_CACHE_DIR. */
function rowSaveDir(configDigest: string | null | undefined): string {
  try {
    if (configDigest && configDigest.startsWith("{")) {
      const parsed = JSON.parse(configDigest);
      if (typeof parsed?.saveDir === "string" && parsed.saveDir) return parsed.saveDir;
    }
  } catch { /* not a directory marker — legacy or llama row */ }
  return KV_CACHE_DIR;
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
      "SELECT chat_id, filename, bytes, config_digest FROM kv_snapshots WHERE pool_key = ? AND state = 'ready' AND chat_id != ? ORDER BY last_used_at ASC",
    )
    .all(poolKey, keepChatId) as Array<{
      chat_id: string;
      filename: string;
      bytes: number;
      config_digest: string;
    }>;
  let poolBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  for (const row of rows) {
    if (poolBytes + estimate <= policy.maxBytesPerPool) break;
    poolBytes -= row.bytes;
    if (row.filename) void unlinkFile(snapshotPath(row.filename, rowSaveDir(row.config_digest)));
    database.prepare("DELETE FROM kv_snapshots WHERE chat_id = ?").run(row.chat_id);
    console.log(`${LOG} LRU-evicted chat=${short(row.chat_id)} to make room`);
  }
}

async function freeDiskBytes(dir: string = KV_CACHE_DIR): Promise<number | null> {
  try {
    const stats = await statfs(dir);
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
    // `saving` claim is older than the largest possible save budget
    // (scaled budgets reach the 5-minute ceiling for 200k+ token states).
    database
      .prepare("UPDATE kv_snapshots SET state = 'stale' WHERE state IN ('saving', 'restoring') AND saved_at < ?")
      .run(now - (SAVE_BUDGET_MAX_MS + policy.opTimeoutMs));

    const rows = database
      .prepare("SELECT chat_id, filename, bytes, state, saved_at, config_digest FROM kv_snapshots")
      .all() as Array<{
        chat_id: string;
        filename: string;
        bytes: number;
        state: string;
        saved_at: number;
        config_digest: string;
      }>;

    for (const row of rows) {
      try {
        const expired = now - row.saved_at > ttlMs;
        if (expired || row.state === "stale") {
          if (row.filename) await unlinkFile(snapshotPath(row.filename, rowSaveDir(row.config_digest)));
          database.prepare("DELETE FROM kv_snapshots WHERE chat_id = ?").run(row.chat_id);
          if (expired) report.expired++;
          else report.staleRemoved++;
          continue;
        }
        if (row.state === "ready" && row.filename) {
          const path = snapshotPath(row.filename, rowSaveDir(row.config_digest));
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

    // Orphan files: anything in the default directory not referenced by a row.
    // Non-default saveDirs are never swept for orphans — they belong to the
    // server's own directory contract (setup note: point a single-slot
    // server's save path at the KV cache dir for the full lifecycle).
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
 * misleading. Also supersedes any queued-but-unrun save job, and — via
 * `spineRewrittenAt` — suppresses parks enqueued LATER whose slot witness
 * pre-dates this rewrite (the invalidate-then-release race: end-of-turn
 * compaction drops the snapshot, then the lease release parks the stale
 * pre-rewrite slot state the drop just discarded). Re-armed by the next DONE
 * chat request, which refills the slot with the rewritten spine.
 */
export async function invalidateKvSnapshot(chatId: string, reason: string): Promise<void> {
  try {
    spineRewrittenAt.set(chatId, Date.now());
    pendingTokens.set(chatId, (pendingTokens.get(chatId) ?? 0) + 1);
    turnPrefixDigests.delete(chatId);
    restoreAttemptTurns.delete(chatId);
    for (const key of [...pendingRestoreValidation.keys()]) {
      if (key.startsWith(`${chatId}:`)) pendingRestoreValidation.delete(key);
    }
    const database = getDb();
    const row = database
      .prepare("SELECT filename, config_digest FROM kv_snapshots WHERE chat_id = ?")
      .get(chatId) as { filename: string; config_digest: string } | undefined;
    database.prepare("DELETE FROM kv_snapshots WHERE chat_id = ?").run(chatId);
    if (row?.filename) {
      await unlinkFile(snapshotPath(row.filename, rowSaveDir(row.config_digest)));
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

/**
 * Wipe the disk tier: rows, tracked files, and the slot-ownership witness.
 * Called when the inference backend flips (routes/settings.ts): slot files
 * are opaque per server format and every restore path already skips on
 * pool-key mismatch, so cross-backend rows are dead weight — worse, they
 * hold the disk headroom that parking budgets against (docs/design/
 * strata-backend.md §7). Total by contract; returns what was cleared.
 */
export async function clearAllKvSnapshots(reason: string): Promise<{ rows: number; bytes: number }> {
  try {
    const rows = getDb()
      .prepare("SELECT chat_id, filename, bytes, config_digest FROM kv_snapshots")
      .all() as Array<{ chat_id: string; filename: string; bytes: number; config_digest: string }>;
    let bytes = 0;
    for (const row of rows) {
      if (row.filename) {
        await unlinkFile(snapshotPath(row.filename, rowSaveDir(row.config_digest)));
        bytes += row.bytes;
      }
    }
    getDb().prepare("DELETE FROM kv_snapshots").run();
    slotOwner.clear();
    console.log(`${LOG} cleared ${rows.length} snapshot(s) (${formatGiB(bytes)}) reason=${reason}`);
    return { rows: rows.length, bytes };
  } catch (error: any) {
    console.warn(`${LOG} clear-all failed:`, error?.message || error);
    return { rows: 0, bytes: 0 };
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}

function formatGiB(bytes: number | null): string {
  if (bytes === null) return "unknown";
  return `${(bytes / GIB).toFixed(1)} GiB`;
}
