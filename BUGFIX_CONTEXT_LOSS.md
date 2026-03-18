# Bug Fix: Context Loss in Ongoing Conversations

## Problem

Users reported that ongoing conversations could have messages that are "cut short", and subsequent messages would be "missing all previous context". The agent would respond with messages like "I don't have the context of what we were looking for — this conversation starts fresh for me."

## Root Cause

The bug was in the pending state saving logic when the `ask_user` tool is triggered. In `server/src/routes/chat.ts` (lines 719-738), when saving pending state after `ask_user` is called, the code trims the context messages to keep only messages up to the assistant message with the `ask_user` tool call:

```typescript
const savedMessages = [...context.messages];
while (savedMessages.length > 0) {
  const last = savedMessages[savedMessages.length - 1] as any;
  if (
    last.role === "assistant" &&
    last.content?.some?.((c: any) => c.type === "toolCall" && c.name === "ask_user")
  ) {
    break; // Keep this assistant message
  }
  savedMessages.pop();
}
```

**The Bug:** If the assistant message's `content` structure doesn't match the expected pattern (e.g., `content` is undefined, null, empty, or the tool call isn't properly formatted), the `some()` check fails and the message is popped. This continues until ALL messages are removed, resulting in an empty `savedMessages` array.

When the user responds and the pending state is loaded, `contextMessages` is empty, so the LLM receives no conversation history.

## Fix

### 1. Safety Check in Pending State Save (lines 719-738)

Added a flag to track whether the `ask_user` message was found, and if not, preserve the full context:

```typescript
const savedMessages = [...context.messages];
let foundAskUser = false;
while (savedMessages.length > 0) {
  const last = savedMessages[savedMessages.length - 1] as any;
  if (
    last.role === "assistant" &&
    last.content?.some?.((c: any) => c.type === "toolCall" && c.name === "ask_user")
  ) {
    foundAskUser = true;
    break;
  }
  savedMessages.pop();
}

// Safety: if no ask_user message was found, keep the original context
if (!foundAskUser && context.messages.length > 0) {
  console.warn(`[chat] ask_user message not found in context, preserving full context`);
  savedMessages.push(...context.messages);
}
```

### 2. Safety Check in Resume Path (lines 938-947)

Added a fallback to rebuild context from `chat.messages` if the pending state has an empty context:

```typescript
const contextMessages = pendingState.agentMessages as Message[];

// Safety check: if context is empty, rebuild from chat.messages
if (contextMessages.length === 0 && chat.messages.length > 0) {
  console.warn(`[chat] pending state has empty context, rebuilding from chat.messages`);
  const rebuiltContext = chatMessagesToPiMessages(chat.messages.slice(0, -1), chat.modelId);
  contextMessages.push(...rebuiltContext);
}
```

### 3. Logging for Debugging

Added critical error logging in multiple places to detect if context is unexpectedly empty:
- In `handleChatStream()` entry (line 179)
- In normal message flow (line 1092)
- In follow-up message handling (line 706)
- In edit message flow (line 1231)
- In resume flow (line 1015)

These logs will help identify any future occurrences of context loss.

## Testing

To test this fix:

1. Start a conversation with multiple exchanges
2. Trigger an `ask_user` scenario (if applicable to your workflow)
3. Verify that the agent maintains context throughout the conversation
4. Check server logs for any "CRITICAL: context is empty" messages

## Impact

This fix ensures that conversation context is never lost due to malformed message structures or edge cases in the pending state logic. The agent will now always have access to the conversation history, preventing the "this conversation starts fresh for me" error.
