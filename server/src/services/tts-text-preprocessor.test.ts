import { describe, expect, it } from "vitest";
import { extractTextForTTS, splitIntoSentences } from "./tts-text-preprocessor.js";
import { planTTSChunks } from "./tts-chunking.js";

describe("TTS text preprocessing", () => {
  it("punctuates markdown headings for a natural pause", () => {
    const text = extractTextForTTS("# Summary\nThis is the next line.");

    expect(text).toBe("Summary.\nThis is the next line.");
  });

  it("does not double-punctuate markdown headings", () => {
    const text = extractTextForTTS("## What changed?\nThe parser keeps the question mark.");

    expect(text).toBe("What changed?\nThe parser keeps the question mark.");
  });

  it("keeps heading punctuation when planning chunks", () => {
    const chunks = planTTSChunks("# Summary\nThis is the next line.");

    expect(chunks[0]).toContain("Summary.");
    expect(chunks[0]).not.toContain("Summary This");
  });

  it("splits punctuated headings as sentence boundaries", () => {
    const sentences = splitIntoSentences(extractTextForTTS("# Summary\nThis is the next line."));

    expect(sentences).toEqual(["Summary.", "This is the next line."]);
  });
});
