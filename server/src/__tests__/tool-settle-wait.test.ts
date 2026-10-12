import { describe, expect, it } from "vitest";
import { TOOL_SETTLE_TIMEOUT_MS, waitForToolSettlement } from "../routes/chat.js";

/**
 * Drain settle-wait (stuck-amber row fix). The mid-loop drain
 * (getSteeringMessages / getFollowUpMessages) runs on pi's producer side,
 * concurrently with the SSE consumer's event handling. If it commits the
 * uncommitted assistant row while a tool is still in flight, the row
 * captures the tool_call (its start handler already ran) without the
 * tool_result (its end handler is still in flight) — the row then replays
 * forever in the client's "running" state. waitForToolSettlement polls the
 * consumer's in-flight set until it drains, bounded by a timeout.
 */
describe("waitForToolSettlement", () => {
  it("resolves true immediately when nothing is in flight", async () => {
    const t0 = Date.now();
    await expect(waitForToolSettlement(() => 0, 1000, 5)).resolves.toBe(true);
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it("waits until the in-flight set fully drains", async () => {
    const ids = new Set(["A", "B"]);
    setTimeout(() => ids.delete("A"), 30);
    setTimeout(() => ids.delete("B"), 60);
    const t0 = Date.now();
    await expect(waitForToolSettlement(() => ids.size, 2000, 5)).resolves.toBe(true);
    // It could not have resolved before the second end landed.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });

  it("resolves false at the deadline when a tool never settles", async () => {
    const t0 = Date.now();
    await expect(waitForToolSettlement(() => 1, 75, 10)).resolves.toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  it("timeout covers the max single-tool budget (300s)", () => {
    expect(TOOL_SETTLE_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });
});
