import { afterEach, describe, expect, it } from "vitest";
import {
  _resetContextObservations,
  applyContextWindowFloor,
  getContextWindowFloor,
  recordContextObservation,
} from "../services/context-high-water.js";

describe("context high-water (fix 4 — fb9cdb6f window denominator)", () => {
  afterEach(() => {
    _resetContextObservations();
  });

  describe("recordContextObservation", () => {
    it("records the first observation", () => {
      recordContextObservation("c1", "model-a", "http://localhost:8080", 153_000);
      expect(getContextWindowFloor("c1", "model-a")).toBe(153_000);
    });

    it("keeps the max (high-water), not the last value", () => {
      recordContextObservation("c1", "model-a", "http://localhost:8080", 153_000);
      recordContextObservation("c1", "model-a", "http://localhost:8080", 40_000); // post-compaction shrink
      recordContextObservation("c1", "model-a", "http://localhost:8080", 160_000); // regrowth past old max
      expect(getContextWindowFloor("c1", "model-a")).toBe(160_000);
    });

    it("persists across compaction-sized drops (the floor must not decay)", () => {
      recordContextObservation("c1", "model-a", "http://localhost:8080", 153_000);
      recordContextObservation("c1", "model-a", "http://localhost:8080", 10_000);
      expect(getContextWindowFloor("c1", "model-a")).toBe(153_000);
    });

    it("scopes by chat id", () => {
      recordContextObservation("c1", "model-a", "http://localhost:8080", 153_000);
      expect(getContextWindowFloor("c2", "model-a")).toBe(0);
    });

    it("resets on model swap (identity change)", () => {
      recordContextObservation("c1", "model-a", "http://localhost:8080", 153_000);
      recordContextObservation("c1", "model-b", "http://localhost:8080", 80_000);
      expect(getContextWindowFloor("c1", "model-b")).toBe(80_000);
      expect(getContextWindowFloor("c1", "model-a")).toBe(0);
    });

    it("resets on instance (baseUrl) change, ignoring trailing slashes", () => {
      recordContextObservation("c1", "model-a", "http://localhost:8080", 153_000);
      recordContextObservation("c1", "model-a", "http://localhost:8081/", 80_000);
      expect(getContextWindowFloor("c1", "model-a")).toBe(80_000);
    });

    it("tolerates trailing-slash variation on the same instance", () => {
      recordContextObservation("c1", "model-a", "http://localhost:8080", 153_000);
      recordContextObservation("c1", "model-a", "http://localhost:8080/", 160_000);
      expect(getContextWindowFloor("c1", "model-a")).toBe(160_000);
    });

    it("ignores invalid totals (non-finite, zero, negative)", () => {
      recordContextObservation("c1", "model-a", "http://localhost:8080", 0);
      recordContextObservation("c1", "model-a", "http://localhost:8080", -5);
      recordContextObservation("c1", "model-a", "http://localhost:8080", NaN);
      recordContextObservation("c1", "model-a", "http://localhost:8080", Infinity);
      expect(getContextWindowFloor("c1", "model-a")).toBe(0);
    });

    it("ignores empty identity fields", () => {
      recordContextObservation("", "model-a", "http://localhost:8080", 100);
      recordContextObservation("c1", "", "http://localhost:8080", 100);
      recordContextObservation("c1", "model-a", "", 100);
      expect(getContextWindowFloor("c1", "model-a")).toBe(0);
    });
  });

  describe("getContextWindowFloor", () => {
    it("returns 0 for unknown chats", () => {
      expect(getContextWindowFloor("ghost")).toBe(0);
    });

    it("returns 0 when the model no longer matches", () => {
      recordContextObservation("c1", "model-a", "http://localhost:8080", 153_000);
      expect(getContextWindowFloor("c1", "model-b")).toBe(0);
    });

    it("ignores the modelId filter when omitted", () => {
      recordContextObservation("c1", "model-a", "http://localhost:8080", 153_000);
      expect(getContextWindowFloor("c1")).toBe(153_000);
    });
  });

  describe("applyContextWindowFloor", () => {
    it("keeps the discovered window when the floor is below it", () => {
      expect(applyContextWindowFloor(190_000, 153_000)).toEqual({ window: 190_000, engaged: false });
    });

    it("raises the window to the floor when discovery is below observed reality (fb9cdb6f shape)", () => {
      expect(applyContextWindowFloor(113_152, 153_000)).toEqual({ window: 153_000, engaged: true });
    });

    it("is a no-op at equal values", () => {
      expect(applyContextWindowFloor(153_000, 153_000)).toEqual({ window: 153_000, engaged: false });
    });

    it("no-ops when the floor is absent", () => {
      expect(applyContextWindowFloor(32_768, 0)).toEqual({ window: 32_768, engaged: false });
    });

    it("no-ops when the discovered window is invalid", () => {
      expect(applyContextWindowFloor(0, 153_000)).toEqual({ window: 0, engaged: false });
      expect(applyContextWindowFloor(NaN, 153_000)).toEqual({ window: NaN, engaged: false });
    });
  });
});
