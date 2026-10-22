import { spawn } from "child_process";
import { describe, expect, it } from "vitest";
import { armTtsDeadline, killProcessTree, TTS_FALLBACK_TIMEOUT_MS } from "../services/tts-process.js";

describe("TTS process deadlines", () => {
  it("has a deadline per fallback backend", () => {
    expect(TTS_FALLBACK_TIMEOUT_MS.kokoro).toBeGreaterThan(0);
    expect(TTS_FALLBACK_TIMEOUT_MS["qwen3-tts"]).toBeGreaterThan(0);
    expect(TTS_FALLBACK_TIMEOUT_MS["supertonic-3"]).toBeGreaterThan(0);
  });

  it("fires the timeout and kills the child group", async () => {
    const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    const messages: string[] = [];
    const deadline = armTtsDeadline(proc, 50, (message) => messages.push(message), "Test TTS");

    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(deadline.timedOut()).toBe(true);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Test TTS timed out after");
    } finally {
      killProcessTree(proc, "SIGKILL");
      deadline.clear();
      if (proc.exitCode === null && proc.signalCode === null) {
        await new Promise<void>((resolve) => proc.once("close", () => resolve()));
      }
    }
  });

  it("does not fire after clear()", async () => {
    const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    const messages: string[] = [];
    const deadline = armTtsDeadline(proc, 40, (message) => messages.push(message), "Test TTS");

    try {
      deadline.clear();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deadline.timedOut()).toBe(false);
      expect(messages).toHaveLength(0);
    } finally {
      killProcessTree(proc, "SIGKILL");
      if (proc.exitCode === null && proc.signalCode === null) {
        await new Promise<void>((resolve) => proc.once("close", () => resolve()));
      }
    }
  });
});