# Fix: Self-Modifying Code Crash Recovery

## Problem

When the agent modifies its own source code (via `write_file`, `edit_file`, or `bash` commands that touch server files), tsx watch mode detects the change and restarts the server process. This kills the SSE connection mid-stream, causing:

1. The client shows "Network unavailable — message queued"
2. The partial response is lost
3. Conversation context from the current turn is lost on refresh

## Root Cause

The incremental persistence system (added in mid-turn crash recovery implementation) saves progress **after** each iteration completes:

```typescript
// Lines 583-608 in chat.ts - saves AFTER iteration
await saveChat(chat);
await savePendingState(chat.id, { ...accumulators... });
```

However, when a self-modifying tool executes, the server crashes **during** tool execution — before the iteration completes. This means:

1. The tool call is saved to `chat.messages` (happens at start of execution)
2. But the accumulators (`fullText`, `thinkingText`, `toolResults`, etc.) are NOT saved
3. On restart, the pending state exists but lacks the in-flight data needed to resume

Additionally, the database schema for `pending_states` was missing columns for the mid-turn recovery fields (`fullText`, `thinkingText`, `toolCalls`, `toolResults`, `iterations`, `lastUserMessage`), even though the TypeScript interface defined them.

## Solution

### 1. Pre-Execution Checkpoint (chat.ts)

Added a checkpoint **before** executing tools that can restart the server:

```typescript
// In tool_execution_start event handler
const isSelfModifyingTool = 
  event.toolName === "write_file" || 
  event.toolName === "edit_file" ||
  (event.toolName === "bash" && commandTouchesServerCode);

if (isSelfModifyingTool) {
  // Flush accumulators to disk BEFORE execution
  await saveChat(chat);
  await savePendingState(chat.id, { ...all accumulators... });
}
```

This ensures that if the server restarts during tool execution, the pending state contains:
- All text accumulated so far
- All tool calls and their results (if any completed)
- Current iteration count
- System prompt and context messages

### 2. Database Schema Migration (chat-storage.ts)

Added missing columns to `pending_states` table:

```sql
ALTER TABLE pending_states ADD COLUMN fullText TEXT;
ALTER TABLE pending_states ADD COLUMN thinkingText TEXT;
ALTER TABLE pending_states ADD COLUMN toolCalls JSON;
ALTER TABLE pending_states ADD COLUMN toolResults JSON;
ALTER TABLE pending_states ADD COLUMN iterations INTEGER;
ALTER TABLE pending_states ADD COLUMN lastUserMessage TEXT;
```

Updated `savePendingState()` and `loadPendingState()` to persist/retrieve these fields.

## How Recovery Works

1. **Agent starts modifying source code** (e.g., `write_file` on `chat.ts`)
2. **Pre-execution checkpoint fires** — saves all accumulators to `pending_states`
3. **Tool executes** — file is written, tsx watch detects change
4. **Server restarts** — SSE connection drops, client shows "Network unavailable"
5. **Client reconnects** — queued message is resent
6. **Resume logic detects pending state** with `fullText` and `toolCalls`
7. **Partial assistant message is reconstructed** from saved accumulators
8. **Agent loop continues** via `agentLoopContinue()` — model finishes its turn
9. **Pending state is cleared** after successful resume

## Testing

To test this fix:

1. Start the server in dev mode: `cd server && npm run dev`
2. In an agent chat, ask the agent to modify its own source code:
   ```
   Can you add a console.log statement to chat.ts that logs when a message is received?
   ```
3. The agent will call `read_file`, then `edit_file`
4. When `edit_file` executes, tsx will restart the server
5. After restart, send any message to trigger resume
6. The agent should continue from where it left off, with the partial response intact

## Limitations

- **Tool results during crash**: If a tool is mid-execution when the crash happens, its result may be lost. The checkpoint saves tool calls but not in-flight results.
- **Multiple self-modifications**: If the agent makes multiple sequential self-modifications, each one will trigger a restart and resume cycle. This is acceptable but may be slow.
- **Bash command detection**: The heuristic for detecting self-modifying bash commands (`npm run`, `tsx`, `node`, `/server/`) is not perfect. Some commands that should trigger checkpoints might be missed, and vice versa.

## Future Improvements

1. **File watcher pause**: Could temporarily pause tsx watch during agent turns, then resume after completion
2. **Atomic file writes**: Write to temp file first, then atomic rename — tsx won't trigger until write is complete
3. **Graceful shutdown hook**: On SIGTERM from tsx, flush all pending state before exiting
4. **Tool result journaling**: Save tool results incrementally during long-running tool execution
