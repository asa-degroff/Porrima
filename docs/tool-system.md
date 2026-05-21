# Tool System (Agent Chats)

Uses **native pi-ai tool calling** (`Context.tools`, `ToolCall`, `ToolResultMessage`) with TypeBox schemas — NOT fenced code blocks.

## Registry (`server/src/services/agent-tools.ts`)

- `getAgentTools(chatId, effects, contextWindow)` returns all tools with context-aware result limits; `executeTool(toolCall, chatId, onEvent?)` dispatches by name.
- **Memory tools** (from `memory-tools.ts`): `save_memory`, `search_memory`, `forget_memory`
- **Conversation search**: `search_conversation` — FTS5 search on chat history AND archived context blocks (cross-chat), scoped to single chat or global
- **Archive retrieval**: `read_archived_context` — dereferences an archive block ID to return full original messages (tool outputs, code, reasoning)
- **Memory blocks**: `create_memory_block`, `update_memory_block`, `read_memory_block`, `list_memory_blocks`, `get_block_history` — structured knowledge documents (see [memory-blocks.md](memory-blocks.md))
- **Filesystem tools**: `read_file`, `write_file`, `edit_file`, `list_files`, `bash`
- **Web tools**: `web_search`, `web_fetch` — provider-backed web search (Brave, Exa, Tavily) plus rendered page fetch.
- **Sandbox tools**: `run_python`, `create_artifact`
- **Flow control**: `ask_user` (pauses tool loop, saves pending state to `pending_states` table in SQLite, resumes on next user message)

## Tool Result Limits

Tool results are dynamically truncated based on the effective context window to prevent a single large result from overflowing the context:

- **Formula**: `Math.max(8000, contextWindow * 4 * 0.15)` — 15% of context as chars (4 chars/token estimate)
- 50k context → ~30k char limit; 128k → ~77k; 256k → ~154k
- Truncated results include a message telling the model to use `offset`/`limit` parameters
- `contextWindow` is passed to `getAgentTools()` after model discovery

## Tool Loop (`agent-loop-runner.ts`)

- `server/src/services/agent-loop-runner.ts` is the shared low-level driver around pi-ai's `agentLoop` / `agentLoopContinue`.
- `createSafeStreamFn` in `llm-stream.ts` wraps model streaming with inactivity timeout protection and LLM activity tracking.
- The HTTP chat route owns SSE, persistence, memory extraction, compaction, and pending `ask_user` behavior through callbacks around the shared runner.
- Headless system-chat, wake, and custom automation turns use `runHeadlessChatTurn()` in `chat-turn-runner.ts`, which adapts the same runner to `SynthesisEmitter` events and persisted system-chat rows.
- Tool iterations tracked via `turn_end` events from the agent loop
- Each `turn_end` with `stopReason === "toolUse"` is persisted immediately as a canonical assistant row containing only that iteration's tool calls/results. Rows in the same visible assistant response share `_toolLoopId`; tool-use rows have `_toolLoopFragment: true`.
- The route emits `message_complete` with `continues: true` after a persisted tool-use row so the client can finalize that raw row and create the next live assistant placeholder without showing multiple bubbles.
- **Mid-turn overflow detection**: At each `turn_end` with `stopReason === "toolUse"`, checks if token usage > 85% of context. If so, aborts the agent loop and enters compaction cycle.
- **Multi-cycle compaction** (up to 5): Archives overflow, compacts, injects handoff message (progress summary + tool call log), resumes via `agentLoopContinue`. Each cycle strips all trailing assistant messages before resume.
- **MAX_ITERATIONS**: the HTTP chat route uses a 500-iteration guard; headless automation tasks use each task's `maxIterations`.
- `ask_user` is intercepted — sends SSE `ask_user` event and breaks the loop.
- SSE events during loop: `text_delta`, `thinking_delta`, `tool_status` (running/done/error), `segment`, `artifact`, `ask_user`, `iteration`, `message_complete`, `compaction`.

## Message Reconstruction (`server/src/services/agent.ts`, `chatMessagesToPiMessages()`)

- Canonical persisted rows already mirror pi-ai's live transcript. A `_toolLoopFragment` row with `toolCalls` reconstructs to `AssistantMessage(stopReason:"toolUse")` with its thinking/text/tool calls, followed by that row's `ToolResultMessage[]`. The final assistant row in the same `_toolLoopId` group reconstructs as a normal `AssistantMessage(stopReason:"stop")`.
- Legacy collapsed rows are still supported. A single older `ChatMessage` with `toolCalls` + `toolResults` + final `content` reconstructs as: `AssistantMessage(stopReason:"toolUse")` → `ToolResultMessage[]` → `AssistantMessage(stopReason:"stop")`.
- This shape is critical for KV cache behavior. The follow-up prompt must be byte-compatible with the live tool loop transcript the model previously saw; flattening all tool calls into one assistant row changes the prompt at the first assistant token after the user message and destroys longest-common-prefix reuse.
- For llama.cpp (OpenAI-compat provider): assistant messages include `reasoning_content` for thinking replay; tool results use `tool_call_id` format instead of Ollama's `tool_name`.
