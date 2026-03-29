# generate_and_review - Current Status

## What Works ✅

- Image generation via ComfyUI
- Tool execution completes successfully
- Image displays inline in UI (via tool_result segments)
- Agent receives text description of the creative intent and prompt
- Agent can call the tool multiple times for iterations

## What Doesn't Work ❌

- **Agent cannot visually see the generated image**

The agent receives a text prompt describing what was generated, but cannot actually evaluate the visual output. This is a significant limitation.

## Root Cause

Qwen 3.5 (via Ollama) **rejects images embedded in ToolResultMessage format** with "400 invalid image input" error. However, Qwen 3.5 **does accept images in regular user messages**.

Our attempted fix was to inject the image as a separate user message via `getSteeringMessages()`, but this doesn't work because:

1. `getSteeringMessages()` returns messages that get appended to `context.messages`
2. These messages persist across agent loop iterations
3. On iteration 2, Qwen 3.5 sees the same image again in context and rejects it with "400 invalid image input"

## Required Fix

To properly support image review, we need to:

1. **Modify pi-agent-core** to support "ephemeral" steering messages that are:
   - Sent to the LLM for the immediate next call
   - NOT persisted to `context.messages` for subsequent iterations

2. **OR** modify `chatMessagesToPiMessages()` to filter out previously-injected images based on metadata

3. **OR** use a different model that accepts images in ToolResultMessage format (e.g., LLaVA, Qwen2-VL)

## Workarounds

### Option 1: Use a Dedicated Vision Model

Switch to a model that properly supports images in tool results:

```bash
ollama pull llava:7b
# or
ollama pull qwen2-vl:7b
```

Then change your chat's model selector. These models are designed for vision tasks and handle images in all message formats.

### Option 2: Manual Review Flow

Until the tool flow is fixed:
1. Ask the agent to generate an image using `generate_image` tool
2. You (the user) visually evaluate the image
3. Provide feedback to the agent
4. Agent refines the prompt based on your feedback

This isn't automated, but it works.

### Option 3: Text-Only Review (Current State)

The agent can still iterate on prompts based on:
- The creative intent description
- The prompt used
- Its own "imagination" of what the result might be

This is obviously not ideal, but the tool flow works without errors.

## Implementation Notes

The current implementation:
- Generates images correctly
- Displays them in the UI (via segments)
- Returns text-only tool results to avoid Qwen 3.5 errors
- Allows iterative refinement (though blind)

Files modified:
- `server/src/services/generate-review.ts` - Core generation logic
- `server/src/services/agent-tools.ts` - Tool definition
- `server/src/routes/chat.ts` - Image injection (currently disabled)
- `client/src/components/ToolCallDisplay.tsx` - Inline image display

## Next Steps

To fully fix this:

1. **Short-term:** Test with LLaVA or Qwen2-VL to confirm the tool works with proper vision models

2. **Medium-term:** Patch pi-agent-core to support ephemeral steering messages

3. **Long-term:** Consider a different architecture where images are always in user messages, never in tool results

## Testing

Current behavior:
```
User: "Use generate_and_review to create X"
  ↓
Agent: Calls tool
  ↓
Tool: Generates image, returns text description
  ↓
UI: Shows image inline in tool call ✓
  ↓
Agent: "Based on the creative intent [description], I think..." (blind evaluation)
  ↓
Agent: Can call tool again for iteration 2 ✓
```

The flow works, but the agent is "blind" to the actual visual output.
