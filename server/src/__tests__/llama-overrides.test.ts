import { describe, expect, it } from "vitest";
import { extractOverrideBinaryPath } from "../services/llama-overrides.js";

describe("extractOverrideBinaryPath", () => {
  it("reads the effective binary from a multiline managed drop-in", () => {
    const contents = [
      "# Managed by Porrima",
      "[Service]",
      "ExecStart=",
      "Environment=LD_LIBRARY_PATH=/home/asa/bin/llama-current",
      "ExecStart=/home/asa/bin/llama-current/llama-server \\",
      "    -m \\",
      "    '/home/asa/.local/share/llama-models/Qwen3.5-9B/Qwen3.5-9B.gguf'",
      "",
    ].join("\n");

    expect(extractOverrideBinaryPath(contents)).toBe("/home/asa/bin/llama-current/llama-server");
  });

  it("ignores reset-only ExecStart lines", () => {
    const contents = [
      "[Service]",
      "ExecStart=",
      "",
    ].join("\n");

    expect(extractOverrideBinaryPath(contents)).toBeNull();
  });
});
