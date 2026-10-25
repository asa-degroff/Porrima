import { describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_MAX_OUTPUT_BYTES,
  jobMaxOutputBytes,
} from "./job-output-cap.js";

describe("job output cap", () => {
  it("defaults to 64 MiB", () => {
    expect(jobMaxOutputBytes({})).toBe(64 * 1024 * 1024);
    expect(DEFAULT_JOB_MAX_OUTPUT_BYTES).toBe(64 * 1024 * 1024);
  });

  it("honors a byte override", () => {
    expect(jobMaxOutputBytes({ PORRIMA_JOBS_MAX_OUTPUT_BYTES: "4096" })).toBe(4096);
  });

  it("ignores invalid and absurd values", () => {
    expect(jobMaxOutputBytes({ PORRIMA_JOBS_MAX_OUTPUT_BYTES: "nope" })).toBe(
      DEFAULT_JOB_MAX_OUTPUT_BYTES,
    );
    expect(jobMaxOutputBytes({ PORRIMA_JOBS_MAX_OUTPUT_BYTES: "0" })).toBe(
      DEFAULT_JOB_MAX_OUTPUT_BYTES,
    );
    expect(jobMaxOutputBytes({ PORRIMA_JOBS_MAX_OUTPUT_BYTES: "1" })).toBe(1024);
  });
});