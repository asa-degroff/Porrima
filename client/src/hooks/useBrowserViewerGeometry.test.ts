import { describe, expect, it } from "vitest";
import {
  CHIP_SIZE,
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
    expect(estimateCardHeight(210)).toBe(Math.round((210 * 10) / 16) + 28);
    expect(estimateCardHeight(520)).toBe(Math.round((520 * 10) / 16) + 28);
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
    expect(clampGeometry(g(100, 100, 210), DESKTOP)).toEqual(g(100, 100, 210));
  });

  it("pulls off-screen geometry back inside on all edges", () => {
    const in_ = clampGeometry(g(-500, -500, 210), DESKTOP);
    expect(in_.x).toBeGreaterThanOrEqual(8);
    expect(in_.y).toBeGreaterThanOrEqual(8);
  });

  it("clamps the right/bottom edges against card width and derived height", () => {
    const clamped = clampGeometry(g(9000, 9000, 210), DESKTOP);
    expect(clamped.x).toBe(1000 - 210 - 8);
    expect(clamped.y).toBe(700 - estimateCardHeight(210) - 8);
  });

  it("caps width at the max", () => {
    expect(clampGeometry(g(0, 0, 900), DESKTOP).w).toBe(VIEWER_MAX_W);
  });

  it("caps width at what fits on narrow wrappers", () => {
    const clamped = clampGeometry(g(0, 0, 900), MOBILE);
    expect(clamped.w).toBeLessThanOrEqual(360 - 16);
  });

  it("floors width at the min on wide wrappers", () => {
    expect(clampGeometry(g(0, 0, 10), DESKTOP).w).toBe(VIEWER_MIN_W);
  });

  it("keeps the derived chip corner (x + w - CHIP_SIZE) inside the wrapper", () => {
    // The collapsed chip renders at the card rectangle's top-right corner,
    // so card-rectangle clamping must guarantee chip visibility.
    for (const bounds of [DESKTOP, MOBILE]) {
      for (const start of [g(-999, -999, 10), g(999, 999, 999), g(0, 0, 210)]) {
        const c = clampGeometry(start, bounds);
        expect(c.x).toBeGreaterThanOrEqual(8);
        expect(c.y).toBeGreaterThanOrEqual(8);
        expect(c.x + c.w - CHIP_SIZE).toBeLessThanOrEqual(bounds.w - 8);
        expect(c.y + CHIP_SIZE).toBeLessThanOrEqual(bounds.h - 8);
      }
    }
  });

  it("is idempotent", () => {
    const once = clampGeometry(g(-1, 4000, 700), MOBILE);
    expect(clampGeometry(once, MOBILE)).toEqual(once);
  });
});
