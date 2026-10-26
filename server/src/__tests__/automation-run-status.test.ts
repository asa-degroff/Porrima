import { describe, expect, it } from "vitest";
import { automationRunStatus } from "../services/automation-runner.js";

/**
 * The Oct 26 witness: a 90-minute reminder automation ran 14 healthy iterations
 * (197k → 218k prompt tokens, 98–99.9% cache reuse), lost its turn-gate lease
 * at 15m03s to a job-notice steal, and its 15th provider call aborted. The loop
 * returned without throwing, so the run was filed as `success` with a summary
 * that was exactly the fallback line — 67 characters, no output.
 */
describe("automationRunStatus", () => {
  it("files a run aborted mid-request as interrupted, not success", () => {
    expect(automationRunStatus({ success: true, stopReason: "aborted" })).toBe("interrupted");
  });

  it("files a timed-out run as interrupted", () => {
    expect(automationRunStatus({ success: true, timedOut: true, stopReason: "length" })).toBe(
      "interrupted",
    );
    expect(automationRunStatus({ success: true, stopSource: "timeout" })).toBe("interrupted");
  });

  it("uses the loop's stopSource when the provider finish reason still says stop", () => {
    // The real lease-takeover shape: the controller aborted mid-call, so the
    // provider never produced an "aborted" finish reason. The loop knows it was
    // stopped; that fact must reach the run status.
    expect(
      automationRunStatus({
        success: true,
        stopReason: "stop",
        stopSource: "stopped",
      }),
    ).toBe("interrupted");
    expect(automationRunStatus({ success: true, stopSource: "iteration-cap" })).toBe(
      "interrupted",
    );
  });

  it("keeps a hard error failed even when it also timed out", () => {
    expect(automationRunStatus({ success: false, timedOut: true, stopReason: "aborted" })).toBe(
      "failed",
    );
    expect(automationRunStatus({ success: false, stopReason: "stop" })).toBe("failed");
  });

  it("files a run that finished as success", () => {
    expect(automationRunStatus({ success: true, stopReason: "stop" })).toBe("success");
    expect(automationRunStatus({ success: true, stopReason: "length" })).toBe("success");
    expect(automationRunStatus({ success: true, stopSource: "completed" })).toBe("success");
  });
});
