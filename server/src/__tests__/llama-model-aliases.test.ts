import { describe, expect, it } from "vitest";
import { canExposeNonDiskLlamaModel } from "../services/llama-model-aliases.js";

describe("canExposeNonDiskLlamaModel", () => {
  it("keeps chat-style router slots limited to disk-discovered models", () => {
    expect(canExposeNonDiskLlamaModel("inference")).toBe(false);
    expect(canExposeNonDiskLlamaModel("title-generation")).toBe(false);
    expect(canExposeNonDiskLlamaModel("extraction")).toBe(false);
  });

  it("allows dedicated single-model aliases for embedding and reranker slots", () => {
    expect(canExposeNonDiskLlamaModel("embedding")).toBe(true);
    expect(canExposeNonDiskLlamaModel("reranker")).toBe(true);
  });
});
