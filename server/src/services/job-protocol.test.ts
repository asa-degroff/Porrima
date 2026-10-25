import { describe, expect, it } from "vitest";
import {
  JobLineDecoder,
  encodeJobFrame,
  isJobKind,
  isJobState,
  MAX_JOB_FRAME_BYTES,
} from "./job-protocol.js";

describe("job protocol framing", () => {
  it("decodes multiple newline-delimited frames", () => {
    const decoder = new JobLineDecoder();
    const frames = decoder.push(
      Buffer.from(`${JSON.stringify({ type: "ping" })}\n${JSON.stringify({ type: "stats" })}\n`),
    );
    expect(frames).toHaveLength(2);
    expect(JSON.parse(frames[0]).type).toBe("ping");
    expect(JSON.parse(frames[1]).type).toBe("stats");
  });

  it("preserves multibyte characters split across chunks", () => {
    const text = `${encodeJobFrame({ type: "start", command: "echo héllo ✓" })}`;
    const payload = Buffer.from(text, "utf8");
    const split = payload.indexOf(Buffer.from("é", "utf8")) + 1;
    const decoder = new JobLineDecoder();
    expect(decoder.push(payload.subarray(0, split))).toEqual([]);
    const frames = decoder.push(payload.subarray(split));
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]).command).toBe("echo héllo ✓");
  });

  it("rejects an oversized frame", () => {
    const decoder = new JobLineDecoder(8);
    expect(() => decoder.push(Buffer.from("123456789"))).toThrow(/exceeds/);
  });

  it("validates states and kinds", () => {
    expect(isJobState("running")).toBe(true);
    expect(isJobState("cold")).toBe(false);
    expect(isJobKind("service")).toBe(true);
    expect(isJobKind("cell")).toBe(false);
    expect(MAX_JOB_FRAME_BYTES).toBeGreaterThan(1024);
  });
});