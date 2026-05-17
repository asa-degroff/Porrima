/**
 * Text preprocessing for TTS - strips markdown formatting for natural speech
 * Ported from GreenGale's tts.ts implementation
 */

import type { TTSTextMode } from "../types/tts.js";

/**
 * Strip URLs from text for TTS (URLs don't read well aloud)
 */
function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
}

function formatHeadingForSpeech(heading: string): string {
  const text = heading.replace(/\s+#+\s*$/, "").trim();
  if (!text) return "";
  return /[.!?:;]$/.test(text) ? text : `${text}.`;
}

/**
 * Extract speakable text from markdown for TTS.
 * Mode controls what elements are included or excluded:
 * - "minimal": Keep almost everything (code blocks, inline code, URLs). Strip only LaTeX.
 * - "standard": Strip code blocks and URLs, but keep inline code words.
 * - "stripped": Remove code blocks, inline code, URLs, and LaTeX. (Most aggressive)
 */
export function extractTextForTTS(markdown: string, mode: TTSTextMode = "stripped"): string {
  const keepFencedCode = mode === "minimal";
  const keepInlineCode = mode === "minimal" || mode === "standard";
  const keepUrls = mode === "minimal";
  const stripLatex = true; // Always strip LaTeX — never speaks well

  // Handle fenced code blocks based on mode
  let text = markdown;
  if (keepFencedCode) {
    // Keep fenced code blocks but strip the language identifier and fence markers
    text = text.replace(/```[\w-]*\n([\s\S]*?)```/g, "$1");
  } else {
    text = text.replace(/```[\w-]*\n[\s\S]*?```/g, "");
  }

  // Handle inline code based on mode
  if (keepInlineCode) {
    // Strip backtick markers but keep the content
    text = text.replace(/`([^`]+)`/g, "$1");
  } else {
    text = text.replace(/`[^`]+`/g, "");
  }

  // Handle URLs based on mode
  if (!keepUrls) {
    text = stripUrls(text);
  }

  return (
    text
      // Convert links to just text: [text](url) → text
      // (done before markdown cleanup so link text is preserved)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Clean up orphaned link fragments from URL stripping: [text]( → text
      .replace(/\[([^\]]+)\]\([^)]*$/gm, "$1")
      // Convert headings to punctuated standalone phrases so the next line
      // does not run into the heading during TTS chunking.
      .replace(/^#{1,6}\s+(.+?)\s*$/gm, (_, heading) => formatHeadingForSpeech(heading))
      // Remove bold/italic markers
      .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/___([^_]+)___/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      // Remove strikethrough
      .replace(/~~([^~]+)~~/g, "$1")
      // Remove blockquote markers but keep text
      .replace(/^>\s+/gm, "")
      // Remove horizontal rules
      .replace(/^[-*_]{3,}$/gm, "")
      // Convert list items to sentences (add period if no sentence-ending punctuation)
      .replace(/^([\s]*[-*+]\s+)(.+?)([.!?])?$/gm, (_, _marker, text, punct) => {
        return punct ? text + punct : text + ".";
      })
      .replace(/^([\s]*\d+\.\s+)(.+?)([.!?])?$/gm, (_, _marker, text, punct) => {
        return punct ? text + punct : text + ".";
      })
      // Remove HTML tags
      .replace(/<[^>]+>/g, "")
      // Remove LaTeX (always)
      .replace(/\$\$[\s\S]*?\$\$/g, "")
      .replace(/\$[^$\n]+\$/g, "")
      // Convert parentheses to commas for natural pauses in TTS
      // (parenthetical content) → , parenthetical content,
      .replace(/\(/g, ", ")
      .replace(/\)/g, ", ")
      // Clean up comma artifacts from parentheses conversion
      .replace(/,\s*,/g, ",") // collapse double commas
      .replace(/,\s*([.!?])/g, "$1") // remove comma before sentence-ending punctuation
      .replace(/,\s*:/g, ":") // remove comma before colon
      .replace(/(^|[\n])(\s*),\s*/g, "$1$2") // remove leading comma at line/sentence start
      // Normalize multiple newlines to double (paragraph breaks)
      .replace(/\n{3,}/g, "\n\n")
      // Normalize whitespace
      .replace(/[ \t]+/g, " ")
      .trim()
  );
}

/**
 * Split text into sentences for streaming TTS.
 * Handles paragraph breaks, list items, and common edge cases.
 */
export function splitIntoSentences(text: string): string[] {
  const sentences: string[] = [];

  // Split on newlines first to handle list items and paragraph breaks
  const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  for (const line of lines) {
    // Normalize whitespace within the line
    const normalized = line.replace(/\s+/g, " ").trim();
    if (!normalized) continue;

    // Check if this line ends with a colon (like "Here's what happens:")
    // If so, treat it as its own sentence
    if (normalized.endsWith(":")) {
      sentences.push(normalized);
      continue;
    }

    // Split on sentence-ending punctuation followed by space
    const lineSentences = normalized
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // If no sentences found (e.g., a list item without period), use the whole line
    if (lineSentences.length === 0 && normalized.length > 0) {
      sentences.push(normalized);
    } else {
      sentences.push(...lineSentences);
    }
  }

  return sentences.length > 0 ? sentences : [text.replace(/\s+/g, " ").trim()];
}
