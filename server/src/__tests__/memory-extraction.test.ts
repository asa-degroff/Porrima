import { describe, it, expect } from "vitest";
import { parseExtractionResponse } from "../services/memory-extraction.js";

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

  it("filters out facts with invalid categories", () => {
    const input = `[
      {"text": "Valid", "category": "fact", "importance": 5},
      {"text": "Invalid", "category": "opinion", "importance": 3}
    ]`;
    const result = parseExtractionResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Valid");
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
