import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Global turn gate — FIFO single-slot scheduler for GPU-bound turns.
//
// The llama.cpp inference server only processes one session at a time;
// concurrent turns collide on the single slot and fail with provider errors.
// Every GPU-bound turn (user chats via POST /api/chat, /edit, artifact
// repair, and automation/system-chat turns) acquires a lease here before
// starting inference and releases it when the turn completes. Turns that
// arrive while another turn holds the lease queue in FIFO order instead of
// failing — the HTTP route keeps the client's SSE connection open and emits
// `waiting` events until the lease is granted.
//
// State lives on globalThis so tsx watch reloads don't drop an active lease
// (same pattern as live-streams.ts).
// ---------------------------------------------------------------------------

export interface TurnLease {
  leaseId: string;
  chatId: string;
  acquiredAt: number;
  /** Last activity touch. A lease whose heartbeat goes stale is treated as
   *  dead: its holder hung (e.g. a stalled stream read with bodyTimeout: 0)
   *  and will never release. Stale leases are stolen on the next acquire and
   *  reaped by the scheduler so queued turns are not blocked forever. */
  lastHeartbeatAt: number;
}

export interface TurnQueueInfo {
  /** Chat currently holding the lease, if any. */
  activeChatId: string | null;
  /** 1-based queue position (the caller's own slot when already queued). */
  position: number;
  /** Total waiters currently queued. */
  queuedCount: number;
}

export interface AcquireTurnOptions {
  /** Aborting rejects a still-queued waiter (removes it from the queue). */
  signal?: AbortSignal;
  /** Called on enqueue and whenever a waiter ahead is removed. */
  onQueueUpdate?: (info: TurnQueueInfo) => void;
}

interface Waiter {
  chatId: string;
  enqueuedAt: number;
  resolve: (lease: TurnLease) => void;
  reject: (err: Error) => void;
  onQueueUpdate?: (info: TurnQueueInfo) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface TurnGateState {
  active: TurnLease | null;
  waiters: Waiter[];
}

const state: TurnGateState =
  (globalThis as any)._turnGateState ?? { active: null, waiters: [] };
(globalThis as any)._turnGateState = state;

/**
 * A lease with no heartbeat for this long is considered dead. Healthy turns
 * touch the lease on every loop iteration, every LLM stream event, and during
 * compaction keepalives — so silence means the holder is hung. Generous by
 * design: a large-context prefill can legitimately run several minutes.
 */
const DEFAULT_STALE_LEASE_MS = 15 * 60_000;
const STALE_LEASE_MS = readPositiveIntEnv("TURN_GATE_STALE_LEASE_MS", DEFAULT_STALE_LEASE_MS);

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isStaleLease(lease: TurnLease): boolean {
  return Date.now() - lease.lastHeartbeatAt > STALE_LEASE_MS;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

function makeLease(chatId: string): TurnLease {
  const now = Date.now();
  return { leaseId: randomUUID(), chatId, acquiredAt: now, lastHeartbeatAt: now };
}

function notifyWaiters(): void {
  state.waiters.forEach((waiter, index) => {
    waiter.onQueueUpdate?.({
      activeChatId: state.active?.chatId ?? null,
      position: index + 1,
      queuedCount: state.waiters.length,
    });
  });
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
  if (state.active && isStaleLease(state.active)) {
    const stale = state.active;
    console.warn(
      `[turn-gate] stealing stale lease from chat=${shortId(stale.chatId)} ` +
      `(no heartbeat for ${Math.round((Date.now() - stale.lastHeartbeatAt) / 1000)}s)`,
    );
    releaseTurn(stale);
  }
  if (!state.active) {
    state.active = makeLease(chatId);
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
      enqueuedAt: Date.now(),
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

    state.waiters.push(waiter);
    console.log(
      `[turn-gate] queued turn for chat=${shortId(chatId)} (position ${state.waiters.length}, active=${shortId(state.active!.chatId)})`,
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
    state.active = makeLease(waiter.chatId);
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
      `(no heartbeat for ${Math.round((Date.now() - state.active.lastHeartbeatAt) / 1000)}s)`,
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
    position: ownIndex >= 0 ? ownIndex + 1 : state.waiters.length + 1,
    queuedCount: state.waiters.length,
  };
}
