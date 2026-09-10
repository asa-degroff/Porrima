import { describe, expect, it } from "vitest";
import { formatAgentClock, formatAgentDate, resolveSystemTimeZone } from "../services/time-format.js";

const DENVER = "America/Denver";

describe("formatAgentClock", () => {
  it("renders summer Denver time as MDT with a UTC-06:00 offset", () => {
    // 2026-08-24 06:07 UTC = 2026-08-24 00:07 MDT (just past midnight).
    expect(formatAgentClock(new Date(Date.UTC(2026, 7, 24, 6, 7)), DENVER)).toBe(
      "2026-08-24 00:07 MDT (UTC-06:00)",
    );
  });

  it("renders winter Denver time as MST with a UTC-07:00 offset", () => {
    // 2026-01-10 06:07 UTC = 2026-01-09 23:07 MST (crosses midnight back).
    expect(formatAgentClock(new Date(Date.UTC(2026, 0, 10, 6, 7)), DENVER)).toBe(
      "2026-01-09 23:07 MST (UTC-07:00)",
    );
  });

  it("disambiguates the DST fall-back hour via the offset", () => {
    // Nov 1 2026: Denver falls back at 02:00 MDT (08:00 UTC). Local 01:30
    // happens twice — identical wall clock, different offset.
    const first = formatAgentClock(new Date(Date.UTC(2026, 10, 1, 7, 30)), DENVER);
    const second = formatAgentClock(new Date(Date.UTC(2026, 10, 1, 8, 30)), DENVER);
    expect(first).toBe("2026-11-01 01:30 MDT (UTC-06:00)");
    expect(second).toBe("2026-11-01 01:30 MST (UTC-07:00)");
  });

  it("renders the UTC zone with a +00:00 offset", () => {
    expect(formatAgentClock(new Date(Date.UTC(2026, 7, 24, 6, 7)), "UTC")).toBe(
      "2026-08-24 06:07 UTC (UTC+00:00)",
    );
  });

  it("handles fractional-hour offsets, dropping the duplicated GMT-form name", () => {
    // UTC+05:45 (Nepal). ICU's short name here is "GMT+5:45" — an offset
    // in disguise — so the line keeps only the explicit offset.
    expect(
      formatAgentClock(new Date(Date.UTC(2026, 7, 24, 6, 7)), "Asia/Kathmandu"),
    ).toBe("2026-08-24 11:52 (UTC+05:45)");
  });

  it("defaults to the system zone, matching an explicit system zone", () => {
    const now = new Date();
    expect(formatAgentClock(now)).toBe(formatAgentClock(now, resolveSystemTimeZone()));
  });

  it("falls back to the system zone for invalid or empty zones", () => {
    const now = new Date();
    expect(formatAgentClock(now, "Not/AZone")).toBe(formatAgentClock(now));
    expect(formatAgentClock(now, "")).toBe(formatAgentClock(now));
  });

  it("matches the agreed line shape", () => {
    expect(formatAgentClock(new Date())).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: [A-Z]{2,5})? \(UTC[+-]\d{2}:\d{2}\)$/,
    );
  });
});

describe("formatAgentDate", () => {
  it("renders the local calendar date, matching the agent clock frame", () => {
    // 2026-08-14T05:30Z is still Aug 13 late evening in Denver (23:30 MDT).
    // A raw UTC slice would report "2026-08-14" — a date the agent's [time:]
    // anchor has not reached yet (future-dated memory).
    expect(formatAgentDate("2026-08-14T05:30:00.000Z", DENVER)).toBe("2026-08-13");
    expect(formatAgentDate("2026-08-14T05:30:00.000Z", "UTC")).toBe("2026-08-14");
  });

  it("agrees with the date portion of formatAgentClock", () => {
    for (const iso of ["2026-01-01T06:30:00.000Z", "2026-11-01T08:00:00.000Z"]) {
      expect(formatAgentDate(iso, DENVER)).toBe(
        formatAgentClock(new Date(iso), DENVER).slice(0, 10),
      );
    }
  });

  it("accepts Date and epoch-number inputs", () => {
    const ms = Date.UTC(2026, 7, 14, 5, 30);
    expect(formatAgentDate(new Date(ms), DENVER)).toBe("2026-08-13");
    expect(formatAgentDate(ms, DENVER)).toBe("2026-08-13");
  });

  it("defaults to the system zone and tolerates invalid zones", () => {
    const iso = "2026-08-14T05:30:00.000Z";
    expect(formatAgentDate(iso)).toBe(formatAgentDate(iso, resolveSystemTimeZone()));
    expect(formatAgentDate(iso, "Not/AZone")).toBe(formatAgentDate(iso));
  });

  it("falls back to the raw prefix for unparseable values", () => {
    expect(formatAgentDate("not-a-date")).toBe("not-a-date");
    expect(formatAgentDate("nope")).toBe("nope");
    expect(formatAgentDate("")).toBe("");
  });
});

describe("resolveSystemTimeZone", () => {
  it("returns a non-empty IANA zone", () => {
    expect(resolveSystemTimeZone()).toMatch(/^[A-Za-z_]+\//);
  });
});
