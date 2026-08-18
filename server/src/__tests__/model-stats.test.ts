import { describe, expect, it } from "vitest";
import { resolveCanonicalCachedTokens } from "../services/model-stats.js";

describe("resolveCanonicalCachedTokens", () => {
  it("uses the server-reported count when it matches the delta", () => {
    // b10164 warm hit: prompt=58, prompt_n=4, cached_tokens=54
    const r = resolveCanonicalCachedTokens(58, 4, 54);
    expect(r.cachedTokens).toBe(54);
    expect(r.source).toBe("reported");
    expect(r.diverged).toBe(false);
  });

  it("tolerates ±1 rounding drift between the two sources", () => {
    expect(resolveCanonicalCachedTokens(58, 3, 55).diverged).toBe(false);
    expect(resolveCanonicalCachedTokens(58, 5, 54).source).toBe("reported");
  });

  it("falls back to the delta when the reported value is stubbed", () => {
    // Observed once on the ik-llama fork (Aug 18): cached_tokens=0 on a
    // warm hit where the delta showed the real 2048-token hit.
    const r = resolveCanonicalCachedTokens(4461, 2413, 0);
    expect(r.cachedTokens).toBe(2048);
    expect(r.source).toBe("delta");
    expect(r.diverged).toBe(true);
  });

  it("uses the reported value when no delta is available", () => {
    const r = resolveCanonicalCachedTokens(undefined, undefined, 128);
    expect(r.cachedTokens).toBe(128);
    expect(r.source).toBe("reported");
    expect(r.diverged).toBe(false);
  });

  it("uses the delta when no reported value is available", () => {
    const r = resolveCanonicalCachedTokens(100, 40, undefined);
    expect(r.cachedTokens).toBe(60);
    expect(r.source).toBe("delta");
    expect(r.diverged).toBe(false);
  });

  it("clamps negative deltas to zero", () => {
    const r = resolveCanonicalCachedTokens(40, 50, undefined);
    expect(r.cachedTokens).toBe(0);
  });

  it("clamps negative reported values to zero", () => {
    const r = resolveCanonicalCachedTokens(100, 40, -5);
    expect(r.cachedTokens).toBe(60);
    expect(r.source).toBe("delta");
    expect(r.diverged).toBe(true);
  });

  it("rounds fractional reported values", () => {
    const r = resolveCanonicalCachedTokens(100, 37, 63.4);
    expect(r.cachedTokens).toBe(63);
    expect(r.source).toBe("reported");
  });

  it("ignores non-finite reported values", () => {
    const r = resolveCanonicalCachedTokens(100, 40, Number.NaN);
    expect(r.cachedTokens).toBe(60);
    expect(r.source).toBe("delta");
    expect(r.diverged).toBe(false);
  });

  it("returns nothing when neither source is available", () => {
    const r = resolveCanonicalCachedTokens(undefined, undefined, undefined);
    expect(r.cachedTokens).toBeUndefined();
    expect(r.source).toBe("none");
    expect(r.diverged).toBe(false);
  });
});
