# CLAUDE.md

## Project

qu.je Agent — a local Ollama chat UI with a persistent memory system. npm workspaces monorepo: `server/` (Express + TypeScript) and `client/` (React + Vite + Tailwind).

## Quick reference

- **Server port**: 3001 — `cd server && npm run dev` (tsx watch mode)
- **Client port**: 5173 — `cd client && npm run dev` (Vite, proxies `/api` to server)
- **Build server**: `cd server && npm run build` (outputs to `server/dist/`)
- **Build client**: `cd client && npm run build` (outputs to `client/dist/`)
- **Type check**: `npx tsc --noEmit` from either `server/` or `client/`
- **Data dir**: `~/.quje-agent/` (chats, settings, memories)
- **systemd service**: `quje-agent.service` (user service, auto-starts on boot)

## Architecture

Two chat types: **agent** (memory-augmented) and **quick** (standalone). Existing chats without a `type` field default to "quick".

The server is the integration hub. The chat route (`server/src/routes/chat.ts`) orchestrates:
1. Memory context augmentation (agent chats only)
2. LLM streaming via pi-ai (`streamChat`)
3. Memory tool parsing and execution (agent chats only)
4. Fire-and-forget memory extraction after responses
5. Pre-compaction flush when token usage > 75% of context window

Memory services are in `server/src/services/memory-*.ts`. They share the pi-ai `streamChat` function for LLM calls (extraction, synthesis, tool execution all use it with different system prompts).

## Key patterns

- **Streaming**: SSE with event types `text_delta`, `thinking_delta`, `tool_result`, `done`, `error`
- **Types**: Shared interfaces in `server/src/types.ts` and `client/src/types.ts` (kept in sync manually)
- **Storage**: All persistence is JSON files — `storage.ts` for chats, `memory-storage.ts` for memories. Both use `~/.quje-agent/` as the base directory with `mkdir({ recursive: true })`.
- **Embeddings**: Ollama `qwen3-embedding:0.6b` via `POST http://localhost:11434/api/embed`. Vectors are L2-normalized, so cosine similarity = dot product.
- **Memory scoring**: `cosine_sim * recency_decay * (importance / 10)` with a 30-day half-life on recency.
- **Memory dedup**: cosine > 0.85 between a new fact and existing memory triggers UPDATE instead of ADD.
- **Agent tools**: Fenced ` ```tool ``` ` blocks in assistant output are parsed, executed server-side, and a follow-up LLM call incorporates tool results.
- **Backward compat**: `getChat()` and `listChats()` default missing `type` to "quick".

## Style

- Tailwind v4 with glassmorphism (`backdrop-blur-xl bg-white/[0.08]`)
- Agent-related UI uses purple accent colors; quick chats use blue
- No external state management — React hooks + API calls

## Important notes

- The `memory.ts` routes must define `/status`, `/synthesis/*`, and `/search` **before** the `/:id` param routes to avoid Express matching those paths as IDs.
- `streamChat` from `agent.ts` is reused by extraction, synthesis, and tool execution — it's the single LLM call interface.
- The scheduler (`scheduler.ts`) runs a synthesis check on startup and then hourly via `setInterval`.
- When editing types, update both `server/src/types.ts` and `client/src/types.ts`.
