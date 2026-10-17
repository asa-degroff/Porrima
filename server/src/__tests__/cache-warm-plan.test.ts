import { describe, expect, it } from "vitest";
import { buildPostSynthesisWarmPlan } from "../services/cache-warm-queue.js";

/**
 * Post-synthesis warm plan allocation (recent-first, 10-17 field finding).
 * The old baseline→system→recent order left recent structurally at 0 at
 * capacity 2 (the `--parallel` fallback on Enceladus): the pass warmed the
 * 13k-token baseline and the 68k-token system chat and skipped the three
 * 60k+ user chats — exactly the heads synthesis just changed.
 */

const SYSTEM = "system";
const RECENTS = ["a1", "a2", "a3"];

function capacity(maxSlots: number) {
  return { maxSlots, source: "settings" as const, baseUrl: "http://127.0.0.1:8080" };
}

describe("post-synthesis warm plan (recent-first)", () => {
  it("capacity=2 with recents: recents take all slots (the field case)", () => {
    const plan = buildPostSynthesisWarmPlan(capacity(2), SYSTEM, RECENTS);
    expect(plan.recentChatIds).toEqual(["a1", "a2"]);
    expect(plan.systemChatId).toBeUndefined();
    expect(plan.baseline).toBe(false);
  });

  it("no recents: system and baseline keep the slots (degenerate case unchanged)", () => {
    const plan = buildPostSynthesisWarmPlan(capacity(2), SYSTEM, []);
    expect(plan.recentChatIds).toEqual([]);
    expect(plan.systemChatId).toBe(SYSTEM);
    expect(plan.baseline).toBe(true);
  });

  it("one recent, capacity 2: recent first, then system, baseline starves", () => {
    const plan = buildPostSynthesisWarmPlan(capacity(2), SYSTEM, ["a1"]);
    expect(plan.recentChatIds).toEqual(["a1"]);
    expect(plan.systemChatId).toBe(SYSTEM);
    expect(plan.baseline).toBe(false);
  });

  it("capacity 3: all three recents; system and baseline starve", () => {
    const plan = buildPostSynthesisWarmPlan(capacity(3), SYSTEM, RECENTS);
    expect(plan.recentChatIds).toEqual(RECENTS);
    expect(plan.systemChatId).toBeUndefined();
    expect(plan.baseline).toBe(false);
  });

  it("capacity 4: three recents + system, baseline starves", () => {
    const plan = buildPostSynthesisWarmPlan(capacity(4), SYSTEM, RECENTS);
    expect(plan.recentChatIds).toEqual(RECENTS);
    expect(plan.systemChatId).toBe(SYSTEM);
    expect(plan.baseline).toBe(false);
  });

  it("capacity 5: everyone gets a slot, recents first", () => {
    const plan = buildPostSynthesisWarmPlan(capacity(5), SYSTEM, RECENTS);
    expect(plan.recentChatIds).toEqual(RECENTS);
    expect(plan.systemChatId).toBe(SYSTEM);
    expect(plan.baseline).toBe(true);
  });

  it("capacity 1: the single slot goes to a recent chat", () => {
    const plan = buildPostSynthesisWarmPlan(capacity(1), SYSTEM, RECENTS);
    expect(plan.recentChatIds).toEqual(["a1"]);
    expect(plan.systemChatId).toBeUndefined();
    expect(plan.baseline).toBe(false);
  });

  it("the system chat never counts as a recent", () => {
    const plan = buildPostSynthesisWarmPlan(capacity(3), SYSTEM, [SYSTEM, "a1"]);
    expect(plan.recentChatIds).toEqual(["a1"]);
    expect(plan.systemChatId).toBe(SYSTEM);
    expect(plan.baseline).toBe(true);
  });

  it("duplicate recents are de-duped", () => {
    const plan = buildPostSynthesisWarmPlan(capacity(3), SYSTEM, ["a1", "a1", "a2"]);
    expect(plan.recentChatIds).toEqual(["a1", "a2"]);
  });

  it("no system chat: recents first, then baseline", () => {
    const plan = buildPostSynthesisWarmPlan(capacity(2), undefined, RECENTS);
    expect(plan.recentChatIds).toEqual(["a1", "a2"]);
    expect(plan.systemChatId).toBeUndefined();
    expect(plan.baseline).toBe(false);
  });

  it("recent list is capped at POST_SYNTHESIS_RECENT_CHAT_LIMIT (5)", () => {
    const many = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    const plan = buildPostSynthesisWarmPlan(capacity(7), SYSTEM, many);
    expect(plan.recentChatIds).toHaveLength(5);
    expect(plan.systemChatId).toBe(SYSTEM);
    expect(plan.baseline).toBe(true);
  });
});
