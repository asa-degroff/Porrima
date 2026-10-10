import { describe, expect, it, beforeEach } from "vitest";
import {
  browserFrameUrl,
  clearBrowserFrames,
  frameSummary,
  getBrowserFrame,
  latestBrowserFrame,
  pushBrowserFrame,
  shouldCaptureBrowserFrame,
} from "./browser-frames.js";

const PNG = Buffer.from("fake-png");

function frame(chatId: string, pageUrl: string, capturedAt = Date.now()) {
  return pushBrowserFrame(chatId, {
    png: PNG,
    pageUrl,
    pageTitle: `title:${pageUrl}`,
    capturedAt,
    width: 720,
    height: 450,
  });
}

describe("browser-frames ring", () => {
  beforeEach(() => {
    clearBrowserFrames("c1");
    clearBrowserFrames("c2");
  });

  it("stores frames retrievable by id and tracks the newest as latest", () => {
    const a = frame("c1", "https://a.test", 1000);
    const b = frame("c1", "https://b.test", 2000);
    expect(getBrowserFrame("c1", a.frameId)?.png).toBe(PNG);
    expect(latestBrowserFrame("c1")?.frameId).toBe(b.frameId);
    // frames are per-chat
    expect(getBrowserFrame("c2", a.frameId)).toBeUndefined();
  });

  it("evicts the oldest beyond the ring limit", () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(frame("c1", `https://p${i}.test`, 1000 + i).frameId);
    expect(getBrowserFrame("c1", ids[0])).toBeUndefined();
    expect(getBrowserFrame("c1", ids[1])).toBeUndefined();
    expect(getBrowserFrame("c1", ids[2])?.frameId).toBe(ids[2]);
    expect(latestBrowserFrame("c1")?.frameId).toBe(ids[6]);
  });

  it("assigns unique frame ids", () => {
    const a = frame("c1", "https://x.test", 1);
    const b = frame("c1", "https://x.test", 2);
    expect(a.frameId).not.toBe(b.frameId);
  });

  it("throttles repeat captures within the minimum interval", () => {
    frame("c1", "https://a.test", 10_000); // records lastCaptureAt = 10_000
    expect(shouldCaptureBrowserFrame("c1", 10_500)).toBe(false);
    expect(shouldCaptureBrowserFrame("c1", 12_000)).toBe(true);
  });

  it("throttles independently per chat", () => {
    frame("c1", "https://a.test", 10_000);
    expect(shouldCaptureBrowserFrame("c2", 10_100)).toBe(true);
  });

  it("clear drops frames and resets the throttle", () => {
    const a = frame("c1", "https://a.test", 10_000);
    clearBrowserFrames("c1");
    expect(getBrowserFrame("c1", a.frameId)).toBeUndefined();
    expect(latestBrowserFrame("c1")).toBeUndefined();
    expect(shouldCaptureBrowserFrame("c1", 10_100)).toBe(true);
  });

  it("exposes url + summary shapes for the event/status payloads", () => {
    const a = frame("c1", "https://a.test", 5000);
    expect(browserFrameUrl("c1", a.frameId)).toBe(`/api/browser/frame/c1/${a.frameId}`);
    expect(frameSummary("c1", a)).toEqual({
      frameId: a.frameId,
      imageUrl: `/api/browser/frame/c1/${a.frameId}`,
      pageUrl: "https://a.test",
      pageTitle: "title:https://a.test",
      capturedAt: 5000,
    });
    // summary never carries the bytes
    expect(Object.keys(frameSummary("c1", a))).not.toContain("png");
  });
});
