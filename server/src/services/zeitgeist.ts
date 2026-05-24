import {
  getMemoryBlock,
  getAllMemoryBlocks,
  isHistoricalContextBlock,
} from "./memory-storage.js";

const ZEITGEIST_BLOCK_ID = "blk-zeitgeist-continuity";

/**
 * Get the zeitgeist block content for injection into system prompts.
 * Used by the system chat context builder and memory context builder.
 */
export function getZeitgeistContent(): string | null {
  const block = getMemoryBlock(ZEITGEIST_BLOCK_ID);
  return block?.content || null;
}

/**
 * Get instruction text for memory retrieval, telling the agent it can fetch
 * historical context blocks (zeitgeist archives, synthesis entries, notebook entries).
 * Only returns the hint if at least one historical block exists — avoids wasting
 * ~250 tokens/conversation when there's nothing to find.
 */
export function getZeitgeistArchiveInstruction(): string {
  const historicalBlocks = getAllMemoryBlocks().filter(isHistoricalContextBlock);
  const hasArchives = historicalBlocks.some((b) =>
    b.blockType === "zeitgeist-archive" ||
    b.id.startsWith("blk-archive-") ||
    b.name.startsWith("Zeitgeist Archive -")
  );
  const hasSynthesis = historicalBlocks.some((b) =>
    b.blockType === "synthesis" ||
    b.id.startsWith("blk-synth-")
  );
  const hasNotebook = historicalBlocks.some((b) =>
    b.blockType === "notebook" ||
    b.id.startsWith("blk-notebook-")
  );

  if (!hasArchives && !hasSynthesis && !hasNotebook) return ""; // No historical blocks yet

  const sections: string[] = [];

  if (hasArchives) {
    sections.push(`- **Zeitgeist archives** — snapshots of the continuity block from specific dates. Use list_memory_blocks with query "Zeitgeist Archive" to browse, or "Zeitgeist Archive - YYYY-MM-DD" for a specific date.`);
  }

  if (hasSynthesis) {
    sections.push(`- **Synthesis entries** — your daily synthesis summaries. Use list_memory_blocks with query "Synthesis" to browse.`);
  }

  if (hasNotebook) {
    sections.push(`- **Notebook entries** — your reflective notebook writing. Use list_memory_blocks with query "Notebook" to browse.`);
  }

  return `## Historical Context Access

You have access to historical context through memory blocks:

${sections.join("\n")}

Use search_memory with a relevant query to find blocks about specific topics, then read_memory_block(id) to retrieve the full content. This allows you to understand the narrative context from that period, not just isolated facts.`;
}
