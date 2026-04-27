import webpush from "web-push";
import {
  deleteSubscriptionByEndpoint,
  getSubscriptionsForUser,
  getVapidKeys,
  incrementFailureCount,
  isPresent,
  touchSubscription,
} from "./push-storage.js";

export type PushPayloadType =
  | "message_complete"
  | "task_complete"
  | "test";

export interface PushPayload {
  type: PushPayloadType;
  title: string;
  body: string;
  /** Click target — service worker focuses or opens this URL. */
  url?: string;
  /** Notification tag — same tag collapses repeated entries (per-chat works well). */
  tag?: string;
  /** Optional context the SW or client can use for finer-grained handling. */
  chatId?: string;
  data?: unknown;
}

export interface SendPushOptions {
  /** Skip these device IDs (e.g. the device that initiated the turn). */
  suppressDeviceIds?: string[];
  /** Bypass presence (used by /test from the settings UI). */
  ignorePresence?: boolean;
}

export interface SendPushResult {
  delivered: number;
  suppressed: number;
  expired: number;
  failed: number;
}

const FAILURE_THRESHOLD = 5;

let _vapidConfigured = false;
async function ensureVapid(): Promise<void> {
  if (_vapidConfigured) return;
  const keys = await getVapidKeys();
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  _vapidConfigured = true;
}

export async function sendPush(
  userId: string,
  payload: PushPayload,
  options: SendPushOptions = {}
): Promise<SendPushResult> {
  await ensureVapid();

  const subs = getSubscriptionsForUser(userId);
  if (subs.length === 0) {
    return { delivered: 0, suppressed: 0, expired: 0, failed: 0 };
  }

  const suppressSet = new Set(options.suppressDeviceIds ?? []);
  const result: SendPushResult = { delivered: 0, suppressed: 0, expired: 0, failed: 0 };

  const targets = subs.filter((row) => {
    if (suppressSet.has(row.deviceId)) {
      result.suppressed++;
      return false;
    }
    if (!options.ignorePresence && isPresent(row.deviceId)) {
      result.suppressed++;
      return false;
    }
    return true;
  });

  if (targets.length === 0) return result;

  const body = JSON.stringify(payload);

  await Promise.allSettled(
    targets.map(async (row) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          body,
          { TTL: 60 * 60 } // 1h TTL — push services discard after this
        );
        touchSubscription(row.deviceId);
        result.delivered++;
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          deleteSubscriptionByEndpoint(row.endpoint);
          result.expired++;
          return;
        }
        const failures = incrementFailureCount(row.deviceId);
        if (failures >= FAILURE_THRESHOLD) {
          deleteSubscriptionByEndpoint(row.endpoint);
          result.expired++;
          console.warn(
            `[push] dropping subscription ${row.deviceId.slice(0, 8)}… after ${failures} consecutive failures`
          );
          return;
        }
        result.failed++;
        console.warn(
          `[push] send failed for ${row.deviceId.slice(0, 8)}… status=${status ?? "?"}: ${err?.message ?? err}`
        );
      }
    })
  );

  return result;
}

export function truncateForBody(text: string, maxChars = 140): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  // Try a clean break at a sentence/word boundary near the cap.
  const slice = trimmed.slice(0, maxChars);
  const lastBoundary = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("\n")
  );
  if (lastBoundary > maxChars * 0.6) {
    return slice.slice(0, lastBoundary + 1).trim() + "…";
  }
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.6) {
    return slice.slice(0, lastSpace).trim() + "…";
  }
  return slice.trim() + "…";
}
