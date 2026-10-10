import { describe, expect, it } from "vitest";
import {
  VIEWER_MAX_W,
  VIEWER_MIN_W,
  clampGeometry,
  defaultGeometry,
  estimateCardHeight,
  type ViewerBounds,
  type ViewerGeometry,
} from "./useBrowserViewerGeometry";

const DESKTOP: ViewerBounds = { w: 1000, h: 700 };
const MOBILE: ViewerBounds = { w: 360, h: 640 };

const g = (x: number, y: number, w: number): ViewerGeometry => ({ x, y, w });

describe("estimateCardHeight", () => {
  it("derives height from the 16:10 frame plus the footer row", () => {
    expect(estimateCardHeight(210, false)).toBe(Math.round((210 * 10) / 16) + 28);
    expect(estimateCardHeight(520, false)).toBe(Math.round((520 * 10) / 16) + 28);
  });

  it("is the 40px chip when collapsed", () => {
    expect(estimateCardHeight(210, true)).toBe(40);
  });
});

describe("defaultGeometry", () => {
  it("docks top-right on desktop (the original fixed placement)", () => {
    expect(defaultGeometry(DESKTOP)).toEqual({ x: 1000 - 210 - 24, y: 16, w: 210 });
  });

  it("docks top-right at the mobile size on narrow wrappers", () => {
    expect(defaultGeometry(MOBILE)).toEqual({ x: 360 - 132 - 8, y: 12, w: 132 });
  });
});

describe("clampGeometry", () => {
  it("leaves in-bounds geometry unchanged", () => {
    expect(clampGeometry(g(100, 100, 210), DESKTOP, false)).toEqual(g(100, 100, 210));
  });

  it("pulls off-screen geometry back inside on all edges", () => {
    const out = g(-500, -500, 210);
    const in_ = clampGeometry(out, DESKTOP, false);
    expect(in_.x).toBeGreaterThanOrEqual(8);
    expect(in_.y).toBeGreaterThanOrEqual(8);
  });

  it("clamps the right/bottom edges against card width and derived height", () => {
    const pushed = g(9000, 9000, 210);
    const clamped = clampGeometry(pushed, DESKTOP, false);
    expect(clamped.x).toBe(1000 - 210 - 8);
    expect(clamped.y).toBe(700 - estimateCardHeight(210, false) - 8);
  });

  it("caps width at the max", () => {
    expect(clampGeometry(g(0, 0, 900), DESKTOP, false).w).toBe(VIEWER_MAX_W);
  });

  it("caps width at what fits on narrow wrappers", () => {
    const clamped = clampGeometry(g(0, 0, 900), MOBILE, false);
    expect(clamped.w).toBeLessThanOrEqual(360 - 16);
  });

  it("floors width at the min on wide wrappers", () => {
    expect(clampGeometry(g(0, 0, 10), DESKTOP, false).w).toBe(VIEWER_MIN_W);
  });

  it("keeps width intact when collapsed and clamps the 40px chip box", () => {
    const clamped = clampGeometry(g(-999, 9999, 260), DESKTOP, true);
    expect(clamped.w).toBe(260);
    expect(clamped.x).toBeGreaterThanOrEqual(8);
    expect(clamped.y).toBe(700 - 40 - 8);
  });

  it("is idempotent", () => {
    const once = clampGeometry(g(-1, 4000, 700), MOBILE, false);
    expect(clampGeometry(once, MOBILE, false)).toEqual(once);
  });
});
