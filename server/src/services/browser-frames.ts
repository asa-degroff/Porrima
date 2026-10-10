/**
 * In-memory ring of browser action frames for the live viewer
 * (docs/design/browser-observability.md Phase 2).
 *
 * These are observability bytes, NOT conversation content: auto-captured
 * frames are never referenced by message rows, never hydrated for model
 * replay, and never written to disk — they live here until the owning
 * browser session closes or the ring rolls over. Explicit browser_screenshot
 * results keep their existing tool-result-image disk lifecycle untouched;
 * they additionally land in this ring so `latestFrame` always reflects the
 * newest visual the user has seen.
 */

import { randomUUID } from "crypto";

export interface BrowserFrameRecord {
  frameId: string;
  /** PNG bytes, served verbatim by GET /api/browser/frame/:chatId/:frameId. */
  png: Buffer;
  pageUrl: string;
  pageTitle: string;
  capturedAt: number;
  width: number;
  height: number;
}

/** Ring entry without the image bytes — the shape carried by `browser_frame`
 *  events, status payloads, and turn resync snapshots. */
export interface BrowserFrameSummary {
  frameId: string;
  imageUrl: string;
  pageUrl: string;
  pageTitle: string;
  capturedAt: number;
}

const RING_LIMIT = 5;
/** Minimum spacing between auto-captures per chat — a rapid click burst does
 *  not need every intermediate paint, and each capture costs a sharp encode. */
const MIN_FRAME_INTERVAL_MS = 1_500;

const rings = new Map<string, BrowserFrameRecord[]>();
const lastCaptureAt = new Map<string, number>();

export function browserFrameUrl(chatId: string, frameId: string): string {
  return `/api/browser/frame/${chatId}/${frameId}`;
}

/** Throttle gate for AUTO captures (explicit screenshots bypass it — their
 *  bytes already exist for the tool result). Records nothing; push does. */
export function shouldCaptureBrowserFrame(chatId: string, now = Date.now()): boolean {
  const last = lastCaptureAt.get(chatId);
  return last === undefined || now - last >= MIN_FRAME_INTERVAL_MS;
}

/** Append to the ring, evicting the oldest beyond RING_LIMIT. Returns the
 *  stored record with its assigned frameId. */
export function pushBrowserFrame(
  chatId: string,
  frame: Omit<BrowserFrameRecord, "frameId">,
): BrowserFrameRecord {
  const record: BrowserFrameRecord = { frameId: randomUUID(), ...frame };
  const ring = rings.get(chatId) ?? [];
  ring.push(record);
  while (ring.length > RING_LIMIT) ring.shift();
  rings.set(chatId, ring);
  lastCaptureAt.set(chatId, record.capturedAt);
  return record;
}

export function getBrowserFrame(chatId: string, frameId: string): BrowserFrameRecord | undefined {
  return rings.get(chatId)?.find((f) => f.frameId === frameId);
}

export function latestBrowserFrame(chatId: string): BrowserFrameRecord | undefined {
  const ring = rings.get(chatId);
  return ring && ring.length > 0 ? ring[ring.length - 1] : undefined;
}

/** Ring entry without the image bytes, for status/resync payloads. */
export function frameSummary(
  chatId: string,
  frame: BrowserFrameRecord,
): BrowserFrameSummary {
  return {
    frameId: frame.frameId,
    imageUrl: browserFrameUrl(chatId, frame.frameId),
    pageUrl: frame.pageUrl,
    pageTitle: frame.pageTitle,
    capturedAt: frame.capturedAt,
  };
}

/** Drop a chat's frames + throttle marker — called when its browser session
 *  closes (explicit close, idle sweep, or chat deletion). */
export function clearBrowserFrames(chatId: string): void {
  rings.delete(chatId);
  lastCaptureAt.delete(chatId);
}
