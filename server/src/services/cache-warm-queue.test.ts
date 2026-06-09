import { describe, expect, it } from "vitest";
import { slotHasActiveTask } from "./cache-warm-queue.js";

describe("llama slot busy detection", () => {
  it("does not treat stale task ids on idle slots as active work", () => {
    expect(
      slotHasActiveTask({
        id: 0,
        is_processing: false,
        id_task: 46074,
        n_prompt_tokens: 0,
        n_prompt_tokens_processed: 5477,
        next_token: [{ has_next_token: false, n_remain: -1, n_decoded: 360 }],
      }),
    ).toBe(false);
  });

  it("detects explicit active slot state", () => {
    expect(slotHasActiveTask({ is_processing: true, id_task: 10 })).toBe(true);
    expect(slotHasActiveTask({ processing: true })).toBe(true);
    expect(slotHasActiveTask({ state: "busy" })).toBe(true);
    expect(slotHasActiveTask({ next_token: [{ has_next_token: true }] })).toBe(true);
  });

  it("falls back to task ids for older payloads without explicit idle fields", () => {
    expect(slotHasActiveTask({ id_task: 10 })).toBe(true);
    expect(slotHasActiveTask({ id_task: -1 })).toBe(false);
  });
});
