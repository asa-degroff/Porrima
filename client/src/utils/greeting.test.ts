import { describe, expect, it } from "vitest";

import { getGreeting } from "./greeting";

describe("getGreeting", () => {
  it("returns a greeting for the June 16, 2026 slots that previously produced negative indexes", () => {
    expect(getGreeting(new Date(2026, 5, 16, 12))).toBeTruthy();
    expect(getGreeting(new Date(2026, 5, 16, 17))).toBeTruthy();
  });

  it("returns a non-empty greeting for every time slot across the year", () => {
    const slotHours = [0, 5, 12, 17, 22];

    for (let month = 0; month < 12; month += 1) {
      for (let day = 1; day <= 31; day += 1) {
        for (const hour of slotHours) {
          const date = new Date(2026, month, day, hour);
          if (date.getMonth() !== month) continue;
          expect(getGreeting(date)).toEqual(expect.any(String));
          expect(getGreeting(date).length).toBeGreaterThan(0);
        }
      }
    }
  });
});
