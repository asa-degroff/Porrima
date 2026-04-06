# Tool System (Agent Chats)

Uses **native pi-ai tool calling** (`Context.tools`, `ToolCall`, `ToolResultMessage`) with TypeBox schemas — NOT fenced code blocks.

## Registry (`server/src/services/agent-tools.ts`)

- `getAgentTools(chatId, effects, contextWindow)` returns all tools with context-aware result limits; `executeTool(toolCall, chatId, onEvent?)` dispatches by name.
- **Memory tools** (from `memory-tools.ts`): `save_memory`, `search_memory`, `forget_memory`
- **Conversation search**: `search_conversation` — FTS5 search on chat history AND archived context blocks (cross-chat), scoped to single chat or global
- **Archive retrieval**: `read_archived_context` — dereferences an archive block ID to return full original messages (tool outputs, code, reasoning)
- **Memory blocks**: `create_memory_block`, `update_memory_block`, `read_memory_block`, `list_memory_blocks`, `get_block_history` — structured knowledge documents (see [memory-blocks.md](memory-blocks.md))
- **Filesystem tools**: `read_file`, `write_file`, `edit_file`, `list_files`, `bash`
- **Sandbox tools**: `run_python`, `create_artifact`
- **Bluesky tools** (from `bluesky-tools.ts`): `list_notifications`, `get_thread`, `reply`, `post` (bluesky chats only)
- **Flow control**: `ask_user` (pauses tool loop, saves pending state to `pending_states` table in SQLite, resumes on next user message)

## Tool Result Limits

Tool results are dynamically truncated based on the effective context window to prevent a single large result from overflowing the context:

- **Formula**: `Math.max(8000, contextWindow * 4 * 0.15)` — 15% of context as chars (4 chars/token estimate)
- 50k context → ~30k char limit; 128k → ~77k; 256k → ~154k
- Truncated results include a message telling the model to use `offset`/`limit` parameters
- `contextWindow` is passed to `getAgentTools()` after model discovery

## Tool Loop (`server/src/routes/chat.ts`)

- Uses pi-ai's `agentLoop` / `agentLoopContinue` with `createSafeStreamFn` wrapper (inactivity timeout protection)
- Tool iterations tracked via `turn_end` events from the agent loop
- **Mid-turn overflow detection**: At each `turn_end` with `stopReason === "toolUse"`, checks if token usage > 85% of context. If so, aborts the agent loop and enters compaction cycle.
- **Multi-cycle compaction** (up to 5): Archives overflow, compacts, injects handoff message (progress summary + tool call log), resumes via `agentLoopContinue`. Each cycle strips all trailing assistant messages before resume.
- **MAX_ITERATIONS**: 500 guard against runaway tool loops
- `ask_user` is intercepted — sends SSE `ask_user` event and breaks the loop.
- SSE events during loop: `text_delta`, `thinking_delta`, `tool_status` (running/done/error), `segment`, `artifact`, `ask_user`, `iteration`, `compaction`.

## Message Reconstruction (`server/src/services/agent.ts`, `chatMessagesToPiMessages()`)

- A single persisted `ChatMessage` (with `toolCalls` + `toolResults` + `content`) is reconstructed as multiple pi-ai messages: `AssistantMessage(stopReason:"toolUse")` → `ToolResultMessage[]` → `AssistantMessage(stopReason:"stop")` with the final text.
- This split is critical — collapsing tool calls and final text into one message confuses the model into avoiding tool use on replay.
- For llama.cpp (OpenAI-compat provider): assistant messages include `reasoning_content` for thinking replay; tool results use `tool_call_id` format instead of Ollama's `tool_name`.
