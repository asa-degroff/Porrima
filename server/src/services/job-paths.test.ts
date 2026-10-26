import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DATA_DIR } from "./paths.js";
import { defaultSocketPath, jobsConfigFromEnv } from "./job-paths.js";

describe("job supervisor paths", () => {
  it("keeps an explicit data dir's supervisor endpoint inside it", () => {
    const config = jobsConfigFromEnv({
      PORRIMA_DATA_DIR: "/tmp/porrima-dev",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(config).toEqual({
      jobsDir: "/tmp/porrima-dev/jobs",
      dbPath: "/tmp/porrima-dev/jobs.db",
      socketPath: "/tmp/porrima-dev/jobs.sock",
      lockPath: "/tmp/porrima-dev/jobs.lock",
      journalPath: "/tmp/porrima-dev/jobs/journal.jsonl",
    });
  });

  it("uses the short XDG socket when no data dir is explicit", () => {
    expect(defaultSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(
      "/run/user/1000/porrima/jobs.sock",
    );
  });

  it("falls back to the default data dir without XDG", () => {
    expect(defaultSocketPath({})).toBe(join(APP_DATA_DIR, "jobs.sock"));
  });

  it("lets an explicit socket override the data-dir default", () => {
    const config = jobsConfigFromEnv({
      PORRIMA_DATA_DIR: "/tmp/porrima-dev",
      PORRIMA_JOBS_SOCKET: "/tmp/custom-jobs.sock",
    });
    expect(config.socketPath).toBe("/tmp/custom-jobs.sock");
  });
});