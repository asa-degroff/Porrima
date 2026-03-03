# Agent Loop Migration: pi-agent-core

## Overview

The agent chat tool loop was migrated from a manual `while` loop calling `streamChat()` to pi-agent-core's `agentLoop()` function. This replaces ~150 lines of hand-rolled loop/dispatch logic with a structured event-driven architecture while keeping the SSE event format identical (no client changes).

## Motivation

The manual loop had two fragility issues:

1. **Thinking traces from iterations 2+** were lost because the streaming callback only captured the first iteration's thinking. A prior commit patched this by accumulating across iterations, but the fix was brittle.
2. **No built-in follow-up mechanism** — if the model stopped after tool use without continuing, there was no way to automatically prompt it to continue. pi-agent-core provides `getFollowUpMessages` and `getSteeringMessages` hooks for this.

## Architecture

### Before

```
chat.ts handleChatStream()
  while (iterations < 20):
    streamChat() → pi-ai streamSimple()
    if toolUse: executeTool() for each, build ToolResultMessage, push to piMessages
    else: break
```

### After

```
chat.ts handleChatStream()
  agentLoop(prompts, context, config, signal, safeStreamFn)
    → pi-agent-core manages the loop internally
    → emits AgentEvent stream
  for await (event of eventStream):
    map AgentEvent → SSE event
```

pi-agent-core's `agentLoop()` handles:
- Calling the LLM via `streamSimple` (or a custom `StreamFn`)
- Executing tools via `AgentTool.execute()`
- Building and appending `ToolResultMessage`s
- Looping until no more tool calls
- Optional steering/follow-up hooks

## Files Changed

### `server/src/services/agent-tools.ts`

**Old API:**
```typescript
export function getAgentTools(): Tool[]
export async function executeTool(toolCall, chatId, onEvent?): Promise<{ content, isError }>
```

**New API:**
```typescript
export function getAgentTools(chatId: string, effects: ToolSideEffects): AgentTool[]
export function getAgentToolDefinitions(): { name: string; description: string }[]
```

The adapter pattern wraps each existing executor into an `AgentTool.execute` function:
- Success: returns `{ content: [{ type: "text", text }], details: {} }`
- Failure: throws `Error` (pi-agent-core catches it, sets `isError: true` on the tool result)

The `ToolSideEffects` interface provides pure callbacks for side effects that need to cross the tool→route boundary. Tools only call functions — they never read or mutate shared state:

```typescript
interface ToolSideEffects {
  onArtifact: (artifact: Artifact) => void;
  onGeneratedImage: (image: GeneratedImage) => void;
  /** Called when the ask_user tool fires. The route owns the abort/suspend logic. */
  onAskUser: (question: string, toolCallId: string) => void;
}
```

The route creates the `AbortController` and `askUserRef` internally. The `onAskUser` callback stores the question in the ref and calls `abortController.abort()` — tools don't have direct access to either.

`getAgentToolDefinitions()` returns `{ name, description }[]` for display-only metadata (used by the chats route for the context panel).

### `server/src/routes/chat.ts`

The `handleChatStream()` function was rewritten. Key changes:

**Event mapping:**

| AgentEvent | SSE Event |
|---|---|
| `message_update` (text_delta) | `text_delta` |
| `message_update` (thinking_delta) | `thinking_delta` |
| `message_update` (toolcall_start) | `tool_status { status: "running" }` |
| `tool_execution_end` | `tool_status { status: "done" or "error" }` |
| `turn_end` | `iteration { iteration, stopReason }` |
| Post-loop | `done { message, iterations }` |

**ask_user flow:**

The `ask_user` tool can't be intercepted before execution (pi-agent-core runs tools internally), so instead:

1. `ask_user.execute()` calls `effects.onAskUser(question, toolCallId)`, which stores the question in a route-owned ref (`askUserRef.current`) and calls `abortController.abort()`
2. `getSteeringMessages` detects `askUserRef.current` and returns a steering message, causing pi-agent-core to skip remaining tools in the batch via `skipToolCall()`
3. A custom `safeStreamFn` detects the pre-aborted signal on the next LLM call and returns an event stream with `stopReason: "aborted"` instead of throwing
4. pi-agent-core's loop sees the aborted response and exits cleanly via `agent_end`
5. Post-loop code detects `askUserRef.current`, trims `context.messages` back to the assistant message containing the ask_user call, saves pending state, and emits SSE `ask_user` + `done`

The ref pattern (`const askUserRef: { current: T | null } = { current: null }`) is used because TypeScript's control flow analysis can't track `let` variable mutations through closures — a `let pendingAskUser` set inside the `onAskUser` callback would be narrowed to `never` in the post-loop check.

**Resume flow:**

```typescript
// Load saved messages, inject user's answer as tool result
const contextMessages = pendingState.agentMessages as Message[];
contextMessages.push({ role: "toolResult", toolCallId: ..., content: [{ type: "text", text: answer }] });

// agentLoopContinue picks up from the last message (toolResult)
agentLoopContinue(context, config, signal, safeStreamFn);
```

### `server/src/services/agent-state.ts`

```typescript
// Before
interface PendingAgentState {
  piMessages: Message[];        // pi-ai Message[]
  // ...
}

// After
interface PendingAgentState {
  agentMessages: AgentMessage[]; // pi-agent-core AgentMessage[]
  // ...
}
```

### `server/src/routes/chats.ts`

Import changed from `getAgentTools()` to `getAgentToolDefinitions()` for the tool metadata endpoint.

### `server/src/services/agent.ts`

No changes. `streamChat()` is still used by `memory-extraction.ts` and `synthesis.ts` for non-loop LLM calls.

## The safeStreamFn

When `ask_user` aborts the signal, the next `streamSimple` call would throw an unhandled error (the fetch rejects immediately on an already-aborted signal). Since pi-agent-core's internal async IIFE has no error handling, this would cause the `EventStream` to hang forever.

The `createSafeStreamFn()` wrapper checks `signal.aborted` before calling `streamSimple` and returns a synthetic event stream with `{ type: "error", reason: "aborted" }` instead. This allows pi-agent-core to handle the abort through its normal `stopReason === "aborted"` path.

## Iteration Guard

pi-agent-core's `runLoop` uses `while(true)` with no built-in iteration limit. The route adds its own guard:

```typescript
const MAX_ITERATIONS = 20;
// In the turn_end handler:
if (iterations >= MAX_ITERATIONS) {
  res.write(`event: warning\ndata: ${JSON.stringify({
    type: "iteration_limit",
    message: `Stopped — reached ${MAX_ITERATIONS} iteration limit`,
  })}\n\n`);
  abortController.abort();
}
```

This preserves the same 20-iteration cap the manual loop had. When hit, the client receives a `warning` SSE event before the loop stops.

## Hooks

### `getSteeringMessages` (wired up)

Currently used to cleanly skip remaining tools when `ask_user` fires. When `askUserRef.current` is set, it returns a steering message that causes pi-agent-core to call `skipToolCall()` for any remaining tools in the batch, preventing them from executing with an aborted signal.

```typescript
getSteeringMessages: async () => {
  if (askUserRef.current) {
    return [{ role: "user" as const, content: "[paused for user input]", timestamp: Date.now() }];
  }
  return [];
},
```

### `getFollowUpMessages` (not yet wired up)

Called when the agent would otherwise stop. Can inject a user message like "Continue with the task" to prevent premature stopping. Can be added to the `AgentLoopConfig` when needed.
