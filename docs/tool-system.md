# Tool System (Agent Chats)

Uses **native pi-ai tool calling** (`Context.tools`, `ToolCall`, `ToolResultMessage`) with TypeBox schemas — NOT fenced code blocks.

## Registry (`server/src/services/agent-tools.ts`)

- `getAgentTools()` returns all tools; `executeTool(toolCall, chatId, onEvent?)` dispatches by name.
- **Memory tools** (from `memory-tools.ts`): `save_memory`, `search_memory`, `forget_memory`
- **Conversation search**: `search_conversation` — FTS5 search on chat history, scoped to single chat or global
- **Filesystem tools**: `read_file`, `write_file`, `edit_file`, `list_files`, `bash`
- **Sandbox tools**: `run_python`, `create_artifact`
- **Bluesky tools** (from `bluesky-tools.ts`): `list_notifications`, `get_thread`, `reply`, `post` (bluesky chats only)
- **Flow control**: `ask_user` (pauses tool loop, saves pending state to `pending_states` table in SQLite, resumes on next user message)

## Tool Loop (`server/src/routes/chat.ts`)

- `while (iterations < 20)`: calls `streamChat()`, checks `stopReason`. If `"toolUse"`, executes each tool call, appends `ToolResultMessage` to `piMessages`, and loops. Otherwise breaks.
- Three accumulators (`allToolCalls`, `allToolResults`, `allArtifacts`) collect across all iterations and are saved on the final `ChatMessage`.
- `ask_user` is intercepted before `executeTool` — sends SSE `ask_user` event and breaks the loop.
- SSE events during loop: `text_delta`, `thinking_delta`, `tool_status` (running/done/error), `artifact`, `ask_user`.

## Message Reconstruction (`server/src/services/agent.ts`, `chatMessagesToPiMessages()`)

- A single persisted `ChatMessage` (with `toolCalls` + `toolResults` + `content`) is reconstructed as multiple pi-ai messages: `AssistantMessage(stopReason:"toolUse")` → `ToolResultMessage[]` → `AssistantMessage(stopReason:"stop")` with the final text.
- This split is critical — collapsing tool calls and final text into one message confuses the model into avoiding tool use on replay.
