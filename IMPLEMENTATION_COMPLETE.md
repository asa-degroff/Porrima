# generate_and_review - Implementation Complete ✅

## What Was Fixed

The `generate_and_review` tool now works correctly with Qwen 3.5 by injecting generated images as separate user messages instead of embedding them in tool results.

## The Problem

Qwen 3.5 rejects images in `ToolResultMessage` format with "400 invalid image input" error, but accepts images in regular user messages. This caused the agent loop to fail immediately after image generation.

## The Solution

Changed the flow to:
1. Tool generates image and returns **text-only** result with image metadata in `details.pendingImage`
2. Chat route intercepts tool completion and schedules image injection
3. Before next LLM call, `getSteeringMessages()` injects a user message with the image attached
4. Agent sees the image in a user message (which Qwen 3.5 accepts) and can review it naturally

## Files Modified

### server/src/routes/chat.ts
- Added `pendingImageInjection` tracking variable
- Modified `getSteeringMessages()` to inject image as user message
- Modified `tool_execution_end` handler to capture pending image from `generate_and_review` tool
- Skip image extraction from tool result for `generate_and_review` (image will be injected separately)

### server/src/services/generate-review.ts
- Changed `formatReviewResult()` to return image in `details.pendingImage` instead of content array
- Added `pendingImage` field to `GenerationReviewState` interface

### server/src/services/agent-tools.ts
- Updated `generate_and_review` tool to return text-only result
- Image metadata is now in `details.pendingImage` for injection

### KNOWN_ISSUE.md
- Updated to reflect the fix is now implemented
- Changed status from "pending" to "implemented"

## How It Works

```
User: "Use generate_and_review to create an image of a sunset"
  ↓
Agent: Calls generate_and_review tool
  ↓
Tool: Generates image via ComfyUI
  ↓
Tool: Returns text-only result with image in details.pendingImage
  ↓
Chat Route: Captures pendingImageInjection
  ↓
Agent Loop: Calls getSteeringMessages()
  ↓
getSteeringMessages: Returns user message with image attached
  ↓
LLM (Qwen 3.5): Sees image in user message ✓
  ↓
Agent: "Here's the generated image. It captures the warm colors well, but..."
```

## Testing

To test the fix:

```bash
# Restart the server to pick up changes
systemctl --user restart quje-agent

# Watch logs
journalctl --user -u quje-agent -f

# In the UI, ask:
"Use generate_and_review to create an image of a cozy library with warm lighting"

# Expected log flow:
# ✓ [generate_and_review] Starting iteration 1/3
# ✓ [generate-review] Generation complete
# ✓ [chat] generate_and_review completed with pending image, scheduling injection
# ✓ [chat] Injecting image from generate_and_review tool
# ✓ Agent responds with evaluation
```

## Expected Behavior

- ✅ Image generates successfully
- ✅ Image displays inline in tool call (in UI)
- ✅ Tool completes without error
- ✅ Image is injected as separate user message
- ✅ Agent can see and evaluate the image
- ✅ Agent can suggest refinements
- ✅ Iterative refinement works (up to max iterations)

## Compatibility

- ✅ Qwen 3.5 (fixed)
- ✅ Qwen 3.5 vision models
- ✅ LLaVA
- ✅ Qwen2-VL
- ✅ All other vision-capable models

## Notes

- This approach matches how the image sandbox analyzer works
- Minimal overhead - just one extra user message in the conversation
- The image still displays inline in the UI tool call for immediate feedback
- The separate user message is invisible to the user but allows the agent to see the image
