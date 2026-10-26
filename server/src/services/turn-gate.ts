import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Global turn gate — FIFO single-slot scheduler for GPU-bound turns.
//
// The llama.cpp inference server only processes one session at a time;
// concurrent turns collide on the single slot and fail with provider errors.
// Every GPU-bound turn (user chats via POST /api/chat, /edit, artifact
// repair, and automation/system-chat turns) acquires a lease here before
// starting inference and releases it when the turn completes. Cache-warm
// prefills acquire the same lease (kind "cache-warm", background priority)
// so a warm and a turn never dispatch concurrently; a foreground turn
// preempts a running background warm. Turns that arrive while another turn
// holds the lease queue in FIFO order instead of failing — the HTTP route
// keeps the client's SSE connection open and emits `waiting` events until
// the lease is granted (then a `turn_start`).
//
// State lives on globalThis so tsx watch reloads don't drop an active lease
// (same pattern as live-streams.ts).
// ---------------------------------------------------------------------------

/** What the lease belongs to. "cache-warm" is a background prefill that has
 *  no chat of its own; the client labels the wait from it. */
export type TurnLeaseKind = "chat" | "system" | "cache-warm";

/** Foreground waiters (user turns) are served before background waiters
 *  (cache warms) when both are queued at the gate. */
export type TurnWaitPriority = "foreground" | "background";

export interface TurnLease {
  leaseId: string;
  chatId: string;
  kind: TurnLeaseKind;
  acquiredAt: number;
  /** Last activity touch. A lease whose heartbeat goes stale is treated as
   *  dead: its holder hung (e.g. a stalled stream read with bodyTimeout: 0)
   *  and will never release. Stale leases are stolen on the next acquire and
   *  reaped by the scheduler so queued turns are not blocked forever. */
  lastHeartbeatAt: number;
  /**
   * A holder that declares how long its turn may run (an automation's
   * `timeoutMs`) is judged by that ceiling instead of by silence. Its work is
   * legitimately long — a tool-heavy automation can spend minutes inside one
   * tool call and minutes in a pre-compaction flush — so silence proves
   * nothing about it, while its own declared budget says exactly what is too
   * long. `maxHoldMs` carries that budget into the gate so the two bounds
   * cannot disagree; see `isStaleLease`.
   */
  maxHoldMs: number | null;
}

export interface TurnQueueInfo {
  /** Chat currently holding the lease, if any. */
  activeChatId: string | null;
  /** Lease kind of the active holder — lets the client distinguish a user
   *  chat from a background cache warm. */
  activeKind?: TurnLeaseKind;
  /** 1-based queue position (the caller's own slot when already queued). */
  position: number;
  /** Total waiters currently queued. */
  queuedCount: number;
}

export interface AcquireTurnOptions {
  /** Aborting rejects a still-queued waiter (removes it from the queue). */
  signal?: AbortSignal;
  /** Ceiling for this lease, in ms, for holders that already declare a turn
   *  budget (automations pass `task.timeoutMs`). A declared-budget lease is
   *  reaped when it outlives that budget plus the silence allowance any holder
   *  gets — its post-turn bookkeeping (compaction, extraction flush) is not
   *  covered by the budget it declared, and reaping it mid-flush would hand
   *  the slot to a second turn. */
  maxHoldMs?: number;
  /** Called on enqueue and whenever a waiter ahead is removed. */
  onQueueUpdate?: (info: TurnQueueInfo) => void;
  /** Lease owner kind (default "chat"). */
  kind?: TurnLeaseKind;
  /** Foreground waiters are served before background waiters
   *  (default "foreground"). */
  priority?: TurnWaitPriority;
}

interface Waiter {
  chatId: string;
  kind: TurnLeaseKind;
  priority: TurnWaitPriority;
  enqueuedAt: number;
  resolve: (lease: TurnLease) => void;
  reject: (err: Error) => void;
  onQueueUpdate?: (info: TurnQueueInfo) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  maxHoldMs?: number;
}

interface TurnGateState {
  active: TurnLease | null;
  waiters: Waiter[];
}

const state: TurnGateState =
  (globalThis as any)._turnGateState ?? { active: null, waiters: [] };
(globalThis as any)._turnGateState = state;

/**
 * Two ways a lease is judged dead, and each holder picks one by what it
 * declares at acquire time.
 *
 * Silence rule (default): healthy turns touch the lease on every loop
 * iteration, every LLM stream event, and during compaction keepalives, so a
 * lease with no touch for `STALE_LEASE_MS` belongs to a holder that hung and
 * will never release. Generous by design: a large-context prefill can
 * legitimately run several minutes.
 *
 * Declared-budget rule (`maxHoldMs`): a holder whose turn already has a
 * deadline — an automation's `timeoutMs` — is judged by that deadline instead.
 * Silence is the wrong instrument for it, because its legitimate work is
 * silent in exactly the ways the progress rule rewards: a single tool call can
 * run for minutes, and end-of-turn compaction can spend longer in an
 * extraction flush than the turn itself spent generating. The + `STALE_LEASE_MS`
 * grace covers that bookkeeping, which the declared budget does not cover; a
 * lease reaped mid-flush would hand the slot to a second turn, which is the
 * collision the gate exists to prevent.
 */
const DEFAULT_STALE_LEASE_MS = 15 * 60_000;
const STALE_LEASE_MS = readPositiveIntEnv("TURN_GATE_STALE_LEASE_MS", DEFAULT_STALE_LEASE_MS);

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isStaleLease(lease: TurnLease): boolean {
  if (lease.maxHoldMs != null) {
    return Date.now() - lease.acquiredAt > lease.maxHoldMs + STALE_LEASE_MS;
  }
  return Date.now() - lease.lastHeartbeatAt > STALE_LEASE_MS;
}

function staleReason(lease: TurnLease): string {
  if (lease.maxHoldMs != null) {
    return (
      `held ${Math.round((Date.now() - lease.acquiredAt) / 1000)}s past its ` +
      `${lease.maxHoldMs}ms budget (+${Math.round(STALE_LEASE_MS / 1000)}s bookkeeping grace)`
    );
  }
  return `no heartbeat for ${Math.round((Date.now() - lease.lastHeartbeatAt) / 1000)}s`;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

function makeLease(
  chatId: string,
  kind: TurnLeaseKind,
  maxHoldMs?: number,
): TurnLease {
  const now = Date.now();
  return {
    leaseId: randomUUID(),
    chatId,
    kind,
    acquiredAt: now,
    maxHoldMs: maxHoldMs ?? null,
    lastHeartbeatAt: now,
  };
}

/** Omit the default "chat" kind from wire payloads/tests; the client treats
 *  an absent kind as a user chat. */
function reportedActiveKind(lease: TurnLease | null | undefined): TurnLeaseKind | undefined {
  return lease && lease.kind !== "chat" ? lease.kind : undefined;
}

function notifyWaiters(): void {
  state.waiters.forEach((waiter, index) => {
    waiter.onQueueUpdate?.({
      activeChatId: state.active?.chatId ?? null,
      activeKind: reportedActiveKind(state.active),
      position: index + 1,
      queuedCount: state.waiters.length,
    });
  });
}

/**
 * Insert a waiter in front of any background waiters. User turns never queue
 * behind cache warms that happened to reach the gate first.
 */
function enqueueWaiter(waiter: Waiter): void {
  if (waiter.priority === "background") {
    state.waiters.push(waiter);
    return;
  }
  const firstBackground = state.waiters.findIndex((w) => w.priority === "background");
  if (firstBackground === -1) {
    state.waiters.push(waiter);
  } else {
    state.waiters.splice(firstBackground, 0, waiter);
  }
}

/**
 * Acquire the turn lease. Resolves immediately when no turn is active,
 * otherwise queues the caller in FIFO order and resolves when all earlier
 * waiters have been served. Rejects if `signal` aborts while queued.
 *
 * A stale active lease (no heartbeat — its holder hung) is stolen here so the
 * queue drains instead of deadlocking behind a turn that will never finish.
 */
export function acquireTurn(chatId: string, options?: AcquireTurnOptions): Promise<TurnLease> {
  const kind = options?.kind ?? "chat";
  const priority = options?.priority ?? "foreground";
  if (state.active && isStaleLease(state.active)) {
    const stale = state.active;
    console.warn(
      `[turn-gate] stealing stale lease from chat=${shortId(stale.chatId)} ` +
      `(${staleReason(stale)})`,
    );
    releaseTurn(stale);
  }
  if (!state.active) {
    state.active = makeLease(chatId, kind, options?.maxHoldMs);
    console.log(`[turn-gate] granted turn to chat=${shortId(chatId)} (idle)`);
    return Promise.resolve(state.active);
  }

  return new Promise<TurnLease>((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Turn wait aborted"));
      return;
    }

    const waiter: Waiter = {
      chatId,
      kind,
      priority,
      enqueuedAt: Date.now(),
      maxHoldMs: options?.maxHoldMs,
      resolve,
      reject,
      onQueueUpdate: options?.onQueueUpdate,
      signal,
    };

    if (signal) {
      waiter.onAbort = () => {
        const index = state.waiters.indexOf(waiter);
        if (index < 0) return; // already granted or removed
        state.waiters.splice(index, 1);
        console.log(`[turn-gate] cancelled queued turn for chat=${shortId(chatId)} (was position ${index + 1})`);
        notifyWaiters();
        reject(signal.reason ?? new Error("Turn wait aborted"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }

    enqueueWaiter(waiter);
    console.log(
      `[turn-gate] queued turn for chat=${shortId(chatId)} (position ${state.waiters.indexOf(waiter) + 1}, active=${shortId(state.active!.chatId)})`,
    );
    notifyWaiters();
  });
}

/**
 * Touch a lease's heartbeat. No-op for null, stale-replaced, or foreign
 * leases. Callers: the turn's per-iteration loop, the LLM stream activity
 * hook, and compaction keepalives.
 */
export function heartbeatTurnLease(lease: TurnLease | null | undefined): void {
  if (!lease) return;
  if (state.active?.leaseId !== lease.leaseId) return;
  state.active.lastHeartbeatAt = Date.now();
}

/**
 * Release a lease. No-op for stale/foreign leases. Advances the queue to the
 * next live waiter (skipping any that aborted in the meantime).
 */
export function releaseTurn(lease: TurnLease | null | undefined): void {
  if (!lease) return;
  if (!state.active || state.active.leaseId !== lease.leaseId) return;
  state.active = null;

  while (state.waiters.length > 0) {
    const waiter = state.waiters.shift()!;
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if (waiter.signal?.aborted) continue;
    state.active = makeLease(waiter.chatId, waiter.kind, waiter.maxHoldMs);
    console.log(
      `[turn-gate] granted turn to chat=${shortId(waiter.chatId)} (${state.waiters.length} still queued)`,
    );
    notifyWaiters();
    waiter.resolve(state.active);
    return;
  }
}

export function getActiveTurn(): TurnLease | null {
  return state.active;
}

export function getQueuedTurns(): Array<{ chatId: string; enqueuedAt: number }> {
  return state.waiters.map((w) => ({ chatId: w.chatId, enqueuedAt: w.enqueuedAt }));
}

/** True when a live (non-stale) turn is active OR waiters are queued. A stale
 *  lease alone does not count as busy: its holder hung and will never finish,
 *  so gating background work on it would block automations forever. */
export function isTurnGateBusy(): boolean {
  const liveActive = state.active !== null && !isStaleLease(state.active);
  return liveActive || state.waiters.length > 0;
}

/**
 * Release a stale active lease, if any. Called periodically (scheduler tick)
 * so a hung holder cannot block a queued waiter indefinitely even when no new
 * turn arrives to trigger the steal-on-acquire path.
 */
export function reapStaleTurnLease(): boolean {
  if (state.active && isStaleLease(state.active)) {
    console.warn(
      `[turn-gate] reaping stale lease from chat=${shortId(state.active.chatId)} ` +
      `(${staleReason(state.active)})`,
    );
    releaseTurn(state.active);
    return true;
  }
  return false;
}

/** Snapshot for `waiting` events. Null when the gate is completely idle. A
 *  stale active lease is reported as no active chat: its holder hung, and
 *  telling the user "another chat is active" forever would be a lie. */
export function turnGateStatus(forChatId?: string): TurnQueueInfo | null {
  const liveActive = state.active && !isStaleLease(state.active) ? state.active : null;
  if (!liveActive && state.waiters.length === 0) return null;
  const ownIndex = forChatId ? state.waiters.findIndex((w) => w.chatId === forChatId) : -1;
  return {
    activeChatId: liveActive?.chatId ?? null,
    activeKind: reportedActiveKind(liveActive),
    position: ownIndex >= 0 ? ownIndex + 1 : state.waiters.length + 1,
    queuedCount: state.waiters.length,
  };
}
