import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  DEFAULT_JOB_OUTPUT_RETENTION_DAYS,
  DEFAULT_JOB_RECORD_RETENTION_DAYS,
  jobOutputRetentionMs,
  jobRecordRetentionMs,
  jobViewRetentionMs,
} from "./job-retention.js";

describe("job retention policy", () => {
  it("uses the 14-day output and 30-day record defaults", () => {
    expect(jobOutputRetentionMs({})).toBe(
      DEFAULT_JOB_OUTPUT_RETENTION_DAYS * DAY_MS,
    );
    expect(jobRecordRetentionMs({})).toBe(
      DEFAULT_JOB_RECORD_RETENTION_DAYS * DAY_MS,
    );
    expect(jobViewRetentionMs({})).toBe(DEFAULT_JOB_RECORD_RETENTION_DAYS * DAY_MS);
  });

  it("honors environment overrides", () => {
    const env = {
      PORRIMA_JOBS_OUTPUT_RETENTION_DAYS: "7",
      PORRIMA_JOBS_RECORD_RETENTION_DAYS: "45",
      PORRIMA_JOB_VIEW_RETENTION_DAYS: "90",
    };
    expect(jobOutputRetentionMs(env)).toBe(7 * DAY_MS);
    expect(jobRecordRetentionMs(env)).toBe(45 * DAY_MS);
    expect(jobViewRetentionMs(env)).toBe(90 * DAY_MS);
  });

  it("never shortens the view below the supervisor record window", () => {
    expect(
      jobViewRetentionMs({
        PORRIMA_JOBS_RECORD_RETENTION_DAYS: "60",
        PORRIMA_JOB_VIEW_RETENTION_DAYS: "10",
      }),
    ).toBe(60 * DAY_MS);
  });
});