import { describe, it, expect } from "vitest";
import {
  formatMessageContentForExtraction,
  formatToolArgumentsForExtraction,
  isSubstantiveForPreCompactionExtraction,
  parseExtractionResponse,
  resolveEffectiveExtractionModelId,
} from "../services/memory-extraction.js";
import type { ChatMessage } from "../types.js";

describe("parseExtractionResponse", () => {
  it("parses a valid JSON array of facts", () => {
    const input = `[{"text": "User's name is Alex", "category": "fact", "importance": 8}]`;
    const result = parseExtractionResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      text: "User's name is Alex",
      category: "fact",
      importance: 8,
    });
  });

  it("parses multiple facts", () => {
    const input = `[
      {"text": "User prefers TypeScript", "category": "preference", "importance": 5},
      {"text": "User works at Acme Corp", "category": "fact", "importance": 7}
    ]`;
    const result = parseExtractionResponse(input);
    expect(result).toHaveLength(2);
  });

  it("strips markdown code fences", () => {
    const input = "```json\n[{\"text\": \"User likes cats\", \"category\": \"preference\", \"importance\": 3}]\n```";
    const result = parseExtractionResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("User likes cats");
  });

  it("strips code fences without language tag", () => {
    const input = "```\n[{\"text\": \"Test\", \"category\": \"fact\", \"importance\": 5}]\n```";
    const result = parseExtractionResponse(input);
    expect(result).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(parseExtractionResponse("")).toEqual([]);
    expect(parseExtractionResponse("  ")).toEqual([]);
  });

  it("returns empty array for an empty JSON array", () => {
    expect(parseExtractionResponse("[]")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseExtractionResponse("not json at all")).toEqual([]);
    expect(parseExtractionResponse("{not an array}")).toEqual([]);
  });

  it("remaps facts with invalid categories to \"note\"", () => {
    const input = `[
      {"text": "Valid", "category": "fact", "importance": 5},
      {"text": "Invalid", "category": "opinion", "importance": 3}
    ]`;
    const result = parseExtractionResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Valid");
    expect(result[0].category).toBe("fact");
    expect(result[1].text).toBe("Invalid");
    expect(result[1].category).toBe("note");
  });

  it("filters out facts with missing text", () => {
    const input = `[
      {"text": "", "category": "fact", "importance": 5},
      {"category": "fact", "importance": 5},
      {"text": "Valid", "category": "fact", "importance": 5}
    ]`;
    const result = parseExtractionResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Valid");
  });

  it("accepts all valid categories", () => {
    const input = `[
      {"text": "a", "category": "preference", "importance": 1},
      {"text": "b", "category": "fact", "importance": 2},
      {"text": "c", "category": "behavior", "importance": 3},
      {"text": "d", "category": "instruction", "importance": 4}
    ]`;
    const result = parseExtractionResponse(input);
    expect(result).toHaveLength(4);
  });

  it("extracts JSON array from surrounding text", () => {
    const input = `Here are the facts I extracted:\n[{"text": "Found it", "category": "fact", "importance": 5}]\nThat's all.`;
    const result = parseExtractionResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Found it");
  });
});

describe("isSubstantiveForPreCompactionExtraction", () => {
  const base = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
    role: "user",
    content: "substantive user content",
    timestamp: 1,
    ...overrides,
  });

  it("excludes synthesis, compaction, out-of-context, and system-role rows", () => {
    expect(isSubstantiveForPreCompactionExtraction(base())).toBe(true);
    expect(isSubstantiveForPreCompactionExtraction(base({ _isSynthesisMessage: true }))).toBe(false);
    expect(isSubstantiveForPreCompactionExtraction(base({ _isCompactionSummary: true }))).toBe(false);
    expect(isSubstantiveForPreCompactionExtraction(base({ _outOfContext: true }))).toBe(false);
    expect(isSubstantiveForPreCompactionExtraction(base({ role: "system" }))).toBe(false);
  });
});

describe("formatToolArgumentsForExtraction", () => {
  it("omits exceptionally large payload arguments while preserving small metadata", () => {
    const html = `<!DOCTYPE html>${"<polygon />".repeat(5000)}`;
    const rendered = formatToolArgumentsForExtraction({
      title: "Inverted Corner Perspective",
      html,
      width: 500,
      height: 500,
    });

    expect(rendered).toContain("Inverted Corner Perspective");
    expect(rendered).toContain("\"width\": 500");
    expect(rendered).toContain("omitted large html argument");
    expect(rendered).toMatch(/sha256=[a-f0-9]{12}/);
    expect(rendered).not.toContain("<polygon />");
    expect(rendered.length).toBeLessThan(1000);
  });

  it("bounds formatted tool calls in extraction message content", () => {
    const message: ChatMessage = {
      role: "assistant",
      content: "Created the visual after adjusting the apex.",
      timestamp: 1,
      toolCalls: [{
        id: "tool-1",
        name: "create_visual",
        arguments: {
          title: "Wall spread visual",
          html: "<svg>" + "x".repeat(50_000) + "</svg>",
        },
      }],
      toolResults: [{
        toolCallId: "tool-1",
        toolName: "create_visual",
        content: "Visual created: Wall spread visual",
        isError: false,
      }],
    };

    const rendered = formatMessageContentForExtraction(message);

    expect(rendered).toContain("Created the visual");
    expect(rendered).toContain("Wall spread visual");
    expect(rendered).toContain("omitted large html argument");
    expect(rendered).toContain("Visual created");
    expect(rendered).not.toContain("x".repeat(1000));
    expect(rendered.length).toBeLessThan(2000);
  });
});

describe("resolveEffectiveExtractionModelId", () => {
  it("uses the dedicated extraction model when an extraction URL is configured", () => {
    expect(resolveEffectiveExtractionModelId("Qwen3.6-27B-Q5_K_M", {
      extractionModelUrl: "http://127.0.0.1:32101",
      extractionModelId: "Qwen3.5-4B-IQ4_NL.gguf",
    })).toBe("Qwen3.5-4B-IQ4_NL");
  });

  it("falls back to the caller model when no dedicated extraction URL is configured", () => {
    expect(resolveEffectiveExtractionModelId("Qwen3.6-27B-Q5_K_M", {})).toBe("Qwen3.6-27B-Q5_K_M");
  });
});
