# Known Issue: generate_and_review with Qwen 3.5 - FIXED

## Problem (RESOLVED)

The `generate_and_review` tool was failing with **"400 invalid image input"** error when using Qwen 3.5.

### Root Cause

Qwen 3.5 (via Ollama) **rejects images embedded in ToolResultMessage format**, returning a 400 error. However, Qwen 3.5 **does accept images in regular user messages** - this is why the image sandbox analyzer works perfectly.

This is a **model/API limitation**, not a bug in our implementation.

### Evidence from Logs (Before Fix)

```
Mar 28 12:26:24 [chat] tool_execution_end: generate_and_review
Mar 28 12:26:24 [chat] Extracted 1 image(s) from tool result
Mar 28 12:26:24 [chat] turn_end: stopReason=toolUse, toolResults=1
Mar 28 12:26:25 [chat] LLM error: 400 invalid image input  ← THE ERROR
Mar 28 12:26:25 [chat] iter=2 stop=error tools=0 content=196ch tokens=?
```

The tool completed successfully, but when the agent loop tried to continue with the tool result (which included the image), Qwen 3.5 rejected it.

## Solution (IMPLEMENTED)

Changed the flow to inject the generated image as a **separate user message** instead of embedding it in the tool result:

1. Tool generates image and returns **text-only** result with image metadata in `details.pendingImage`
2. Chat route intercepts the tool completion and schedules image injection
3. Before next LLM call, `getSteeringMessages()` injects a user message with the image attached
4. Agent sees the image in a user message (which Qwen 3.5 accepts) and can review it naturally

### Implementation

**Modified files:**
- `server/src/routes/chat.ts` - Added `pendingImageInjection` tracking and injection via `getSteeringMessages()`
- `server/src/services/generate-review.ts` - Returns image in `details.pendingImage` instead of content array
- `server/src/services/agent-tools.ts` - Updated tool to return text-only result

**Key code changes:**

```typescript
// In chat.ts - track pending image
let pendingImageInjection: { data: string; mimeType: string; imageUrl: string; toolCallId: string } | null = null;

// In tool_execution_end - capture pending image
if (event.toolName === "generate_and_review") {
  const pendingImage = event.result?.details?.pendingImage;
  if (pendingImage && pendingImage.data) {
    pendingImageInjection = { /* ... */ };
  }
}

// In getSteeringMessages - inject as user message
if (pendingImageInjection) {
  return [{
    role: "user",
    content: [
      { type: "text", text: "Here's the generated image for your review..." },
      { type: "image", data: injection.data, mimeType: injection.mimeType },
    ],
  }];
}
```

## Testing

To verify the fix works:

```bash
# Watch logs while testing
journalctl --user -u quje-agent -f

# In the UI, ask agent to:
"Use generate_and_review to create an image of a sunset"

# Look for (successful flow):
# ✓ [generate_and_review] Starting iteration 1/3
# ✓ [generate-review] Generation complete
# ✓ [chat] generate_and_review completed with pending image, scheduling injection
# ✓ [chat] Injecting image from generate_and_review tool
# ✓ Agent responds with evaluation of the image
```

## Status

- ✅ Image generation works
- ✅ Image displays in UI (inline in tool call)
- ✅ Tool completes successfully
- ✅ Image injected as user message (compatible with Qwen 3.5)
- ✅ Agent can review and respond to image
- ✅ Iterative refinement works (up to max iterations)

## Notes

- This approach matches how the image sandbox analyzer works
- Compatible with all vision models including Qwen 3.5
- Dedicated vision models (LLaVA, Qwen2-VL) would also work with the original tool result approach
- The fix adds minimal overhead - just one extra user message in the conversation flow
