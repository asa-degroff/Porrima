import { mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import webpush from "web-push";
import { getDb } from "./chat-storage.js";

const BASE_DIR = join(homedir(), ".quje-agent");
const PUSH_DIR = join(BASE_DIR, "push");
const VAPID_FILE = join(PUSH_DIR, "vapid.json");

export interface PushSubscriptionRow {
  deviceId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
  failureCount: number;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let _schemaReady = false;
function ensureSchema() {
  if (_schemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      deviceId TEXT PRIMARY KEY,
      userId TEXT NOT NULL DEFAULT 'owner',
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      userAgent TEXT,
      label TEXT,
      createdAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      failureCount INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_userId ON push_subscriptions(userId);
  `);
  _schemaReady = true;
}

// ---------------------------------------------------------------------------
// In-memory presence map. globalThis dance keeps it alive across tsx HMR
// reloads, mirroring the live-streams.ts pattern.
// ---------------------------------------------------------------------------

interface PresenceEntry {
  visibleAt: number;
  source: "sse" | "ping";
}

export const pushPresence: Map<string, PresenceEntry> =
  (globalThis as any)._pushPresence || new Map<string, PresenceEntry>();
(globalThis as any)._pushPresence = pushPresence;

const PRESENCE_WINDOW_MS = 30_000;

export function markPresence(deviceId: string, source: "sse" | "ping"): void {
  if (!deviceId) return;
  pushPresence.set(deviceId, { visibleAt: Date.now(), source });
}

export function clearPresence(deviceId: string): void {
  pushPresence.delete(deviceId);
}

export function isPresent(deviceId: string): boolean {
  const entry = pushPresence.get(deviceId);
  if (!entry) return false;
  if (Date.now() - entry.visibleAt > PRESENCE_WINDOW_MS) {
    pushPresence.delete(deviceId);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Subscription CRUD
// ---------------------------------------------------------------------------

export function getSubscriptionsForUser(userId: string): PushSubscriptionRow[] {
  ensureSchema();
  const rows = getDb()
    .prepare(
      "SELECT deviceId, userId, endpoint, p256dh, auth, userAgent, label, createdAt, lastSeenAt, failureCount FROM push_subscriptions WHERE userId = ? ORDER BY createdAt ASC"
    )
    .all(userId) as PushSubscriptionRow[];
  return rows;
}

export function upsertSubscription(row: {
  deviceId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
  label?: string | null;
}): void {
  ensureSchema();
  const now = new Date().toISOString();
  // Upsert by deviceId. If a different deviceId already owns this endpoint
  // (e.g. localStorage cleared and a new deviceId was minted for the same
  // browser install), drop the old row first so the UNIQUE(endpoint) holds.
  getDb()
    .prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND deviceId != ?")
    .run(row.endpoint, row.deviceId);
  getDb()
    .prepare(
      `INSERT INTO push_subscriptions (deviceId, userId, endpoint, p256dh, auth, userAgent, label, createdAt, lastSeenAt, failureCount)
       VALUES (@deviceId, @userId, @endpoint, @p256dh, @auth, @userAgent, @label, @now, @now, 0)
       ON CONFLICT(deviceId) DO UPDATE SET
         endpoint = excluded.endpoint,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         userAgent = excluded.userAgent,
         label = COALESCE(excluded.label, push_subscriptions.label),
         lastSeenAt = excluded.lastSeenAt,
         failureCount = 0`
    )
    .run({
      deviceId: row.deviceId,
      userId: row.userId,
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
      userAgent: row.userAgent ?? null,
      label: row.label ?? null,
      now,
    });
}

export function deleteSubscriptionByDeviceId(deviceId: string): void {
  ensureSchema();
  getDb().prepare("DELETE FROM push_subscriptions WHERE deviceId = ?").run(deviceId);
  pushPresence.delete(deviceId);
}

export function deleteSubscriptionByEndpoint(endpoint: string): void {
  ensureSchema();
  getDb().prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

export function touchSubscription(deviceId: string): void {
  ensureSchema();
  getDb()
    .prepare("UPDATE push_subscriptions SET lastSeenAt = ?, failureCount = 0 WHERE deviceId = ?")
    .run(new Date().toISOString(), deviceId);
}

export function incrementFailureCount(deviceId: string): number {
  ensureSchema();
  const row = getDb()
    .prepare(
      "UPDATE push_subscriptions SET failureCount = failureCount + 1 WHERE deviceId = ? RETURNING failureCount"
    )
    .get(deviceId) as { failureCount: number } | undefined;
  return row?.failureCount ?? 0;
}

// ---------------------------------------------------------------------------
// VAPID keys — lazy generate-on-first-use, persisted to ~/.quje-agent/push/vapid.json
// ---------------------------------------------------------------------------

let _vapidCache: VapidKeys | null = null;
let _vapidLoading: Promise<VapidKeys> | null = null;

export async function getVapidKeys(): Promise<VapidKeys> {
  if (_vapidCache) return _vapidCache;
  if (_vapidLoading) return _vapidLoading;
  _vapidLoading = (async () => {
    mkdirSync(PUSH_DIR, { recursive: true });

    // Env override has priority — useful for ops setups that keep secrets in env.
    const envPub = process.env.VAPID_PUBLIC_KEY;
    const envPriv = process.env.VAPID_PRIVATE_KEY;
    const envSubject = process.env.VAPID_SUBJECT;
    if (envPub && envPriv) {
      const keys: VapidKeys = {
        publicKey: envPub,
        privateKey: envPriv,
        subject: envSubject || "mailto:owner@porrima.local",
      };
      _vapidCache = keys;
      return keys;
    }

    // Apple's APNS-backed Web Push gateway is strict about the VAPID `sub`
    // claim — values that contain `.local`, `localhost`, or other non-routable
    // hostnames trigger BadJwtToken-style rejections. Default to a known-safe
    // example.com mailto so out-of-the-box installs work on iOS without
    // requiring the user to set VAPID_SUBJECT.
    const SAFE_DEFAULT_SUBJECT = "mailto:notifications@example.com";
    const isSafeSubject = (s: string | undefined | null): s is string => {
      if (!s || typeof s !== "string") return false;
      if (!/^(mailto:|https:\/\/)/.test(s)) return false;
      if (/\.local(\b|$|\/|@)/i.test(s)) return false;
      if (/localhost/i.test(s)) return false;
      return true;
    };

    try {
      const data = await readFile(VAPID_FILE, "utf-8");
      const parsed = JSON.parse(data) as VapidKeys;
      if (parsed.publicKey && parsed.privateKey) {
        const subject = isSafeSubject(parsed.subject) ? parsed.subject : SAFE_DEFAULT_SUBJECT;
        if (subject !== parsed.subject) {
          console.warn(
            `[push] overriding stored VAPID subject "${parsed.subject}" with "${subject}" (Apple/APNS rejects local-style subjects)`
          );
          // Persist the corrected subject so subsequent boots are quiet.
          await writeFile(
            VAPID_FILE,
            JSON.stringify({ ...parsed, subject }, null, 2),
            { mode: 0o600 }
          );
        }
        _vapidCache = {
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
          subject,
        };
        return _vapidCache;
      }
    } catch {
      // missing or malformed — regenerate
    }

    const generated = webpush.generateVAPIDKeys();
    const keys: VapidKeys = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      subject: envSubject && isSafeSubject(envSubject) ? envSubject : SAFE_DEFAULT_SUBJECT,
    };
    await writeFile(VAPID_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
    _vapidCache = keys;
    return keys;
  })();
  try {
    return await _vapidLoading;
  } finally {
    _vapidLoading = null;
  }
}
