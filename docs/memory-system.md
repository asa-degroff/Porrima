# Memory System

## Categories (8 types)

- `preference` — user likes, dislikes, stylistic choices
- `fact` — concrete information about the user or their world
- `behavior` — observed patterns in how the user works or communicates
- `instruction` — explicit directives from the user
- `context` — project-level information: architecture, tech choices, ongoing work
- `decision` — choices made and why, tradeoffs considered
- `note` — general observations, curiosities, personal details
- `reflection` — synthesis-only: higher-order insights, cross-session patterns, agent self-reflection

## Project Scoping

Memories have an optional `projectId` field for project-scoped context. The DB auto-migrates the `project_id` column.

## Source Tracking

Memories track `sourceType` ('chat_immediate', 'chat_delayed', 'synthesis', 'supersession') and `sourceId` for lineage. Supersession links (`superseded_by`, `supersedes`) track when memories are updated/contradicted.

## Extraction

- **Immediate extraction**: after each agent response, a background LLM call extracts memories (1-3 sentences each with context and rationale) and deduplicates them against existing memories using cosine similarity (>0.85 triggers UPDATE). Runs fire-and-forget via `memory-extraction.ts`.
- **Delayed extraction**: time-based trigger (configurable threshold, default 30 min) runs on inactive chats. Extracts the full conversation context, injects previously-extracted memories for density, and focuses on new patterns/decisions. Tracks `lastDelayedExtractionAt` and `lastDelayedExtractionMessageIndex` per chat. Uses `updateChatExtractionState()` to avoid touching `lastModified` (preserves chat ordering).
- **Pre-compaction flush**: when a conversation approaches the context window limit (>75% usage), all important facts are extracted and preserved before truncation.

## Context Augmentation

Relevant memories are retrieved via RRF (Reciprocal Rank Fusion) combining vector search + FTS5 full-text search, then injected into the system prompt so the agent naturally references what it knows.

## Agent Tools

The agent can explicitly save, search, and forget memories when asked.

## Daily Synthesis (`synthesis.ts`)

Only runs when agent chats occurred that day (inactive days skipped). Groups today's chats by project, loads AGENTS.md for each active project. Loads today's notebook entries (user + agent, excluding prior synthesis entries). Uses `defaultModelId` from settings (not first Ollama model); captures `thinking_delta` as fallback for qwen3 reasoning mode. Generates reflections (1-5 per day, saved as `reflection` memories with importance 7-9). Writes an agent notebook entry with the synthesis summary. Includes persona pattern analysis (suggestions logged, not auto-applied). System prompt uses first-person for agent actions, third-person for user.

## Creative Cycle Integration

After daily synthesis, scheduler runs `runCorpusCreativeCycle()` — rebuilds clusters, generates creative directions via LLM, saves top directions as `context` memories, then executes top directions as autonomous image generations.
