# generate_and_review Implementation Summary

## Overview

Implemented an iterative image generation tool that allows the agent to generate images, review them against a creative intent, and retry with refined prompts (up to 3 iterations by default).

## Files Changed

### New Files

1. **`server/src/services/generate-review.ts`**
   - Core generation and review logic
   - `generateForReview()`: Generates image via ComfyUI, returns base64 for attachment
   - `buildReviewContext()`: Creates structured evaluation prompt for agent
   - `formatReviewResult()`: Formats tool result with text + image attachment
   - `GenerationReviewState`: Tracks iteration state

2. **`GENERATE_AND_REVIEW.md`**
   - User documentation with examples and best practices

### Modified Files

1. **`server/src/services/agent-tools.ts`**
   - Added `generate_and_review` tool definition
   - Tool accepts: `initialPrompt`, `creativeIntent`, `maxIterations`, `iteration`, `imageHistory`
   - Returns: Text summary + image attachment for agent review
   - Tracks iteration state across multiple calls

2. **`server/src/types.ts`**
   - Extended `ChatToolResult` with optional `images?: ImageAttachment[]`
   - Allows tool results to include generated images

3. **`server/src/routes/chat.ts`**
   - Modified `tool_execution_end` handler to extract images from tool result content
   - Images filtered from `event.result.content` where `type === "image"`
   - Added to `ChatToolResult.images` array

4. **`server/src/services/agent.ts`**
   - Modified `chatMessagesToPiMessages()` to attach images to tool results
   - Converts `ChatToolResult.images` to pi-ai `ToolResultMessage` with image content
   - Enables vision model to see generated images during review

5. **`client/src/types.ts`**
   - Extended `ChatToolResult` with optional `images?: ImageAttachment[]`
   - Mirrors server-side type for client-side rendering

6. **`client/src/components/ToolCallDisplay.tsx`**
   - Added image rendering for tool results with `images` array
   - Uses `UserImage` component with 300px max dimension
   - Displays in expanded tool call view

## Architecture

### Flow

```
User Request
    ↓
Agent calls generate_and_review tool
    ↓
Tool generates image (ComfyUI)
    ↓
Image saved to disk, converted to base64
    ↓
Tool returns: { content: [...], images: [{ data, mimeType, name }] }
    ↓
Chat route extracts images, adds to ChatToolResult
    ↓
Message persisted with images array
    ↓
Agent sees image in next turn (via ToolResultMessage)
    ↓
Agent evaluates against creative intent
    ↓
Agent either:
  - Accepts (continues normal response)
  - Retries (calls generate_and_review with refined prompt, iteration++)
```

### Key Design Decisions

1. **Tool-Based Approach**: Chose tool-based over scheduler-based for:
   - Context preservation (review happens in same turn)
   - Transparency (user sees iteration process)
   - Flexibility (agent can use on-demand)
   - Consistency (fits existing tool architecture)

2. **Image Attachment**: Images attached as base64 in tool result content:
   - Extracted by chat route and stored in `ChatToolResult.images`
   - Reconstructed for pi-ai as `ToolResultMessage` with image content
   - Vision model can evaluate generated images

3. **Iteration Tracking**: State tracked via tool arguments:
   - `iteration`: Current attempt number
   - `maxIterations`: Configurable limit (default 3, range 1-5)
   - `imageHistory`: Previous attempts for reference
   - No server-side state needed (stateless tool execution)

4. **GPU Coordination**: Uses existing ComfyUI integration:
   - `generateImageWithState()` from comfyui.ts
   - Progress tracking via SSE
   - Image saved to corpus automatically

## Testing

### Manual Testing Steps

1. Start server and client:
   ```bash
   cd server && npm run dev
   cd client && npm run dev
   ```

2. Create an agent chat and request:
   ```
   Generate a cyberpunk street scene. I want it to feel lived-in and authentic, not just aesthetic.
   Use the generate_and_review tool to make sure it captures the intent.
   ```

3. Expected behavior:
   - Agent calls `generate_and_review` tool
   - Tool call shows in UI with arguments
   - Image generates (progress visible via SSE)
   - Tool result displays with generated image thumbnail
   - Agent evaluates image against intent
   - Agent may retry with refined prompt (up to max iterations)
   - Final accepted image shown in conversation

### Type Checking

Both server and client pass TypeScript compilation:
```bash
cd server && npx tsc --noEmit  # ✓
cd client && npx tsc --noEmit  # ✓
```

## Integration Points

### Existing Systems Used

- **ComfyUI**: Image generation via `generateImageWithState()`
- **SSE Streaming**: Progress updates during generation
- **Tool Loop**: Native pi-ai tool calling pattern
- **Vision Model**: Agent can see generated images for review
- **Corpus**: Generated images automatically added to corpus
- **Message Persistence**: Images stored with `ChatToolResult`

### No Breaking Changes

- Backward compatible: existing tools unchanged
- Optional `images` field on `ChatToolResult`
- Client gracefully handles missing images
- No database schema changes required

## Future Enhancements

Potential improvements for future iterations:

1. **Vision Model Auto-Review**: Use vision model to automatically evaluate generated images against intent before agent sees them

2. **Batch Generation**: Generate multiple variations in parallel, let agent select best

3. **Comparison View**: Show all iterations side-by-side in UI for final selection

4. **Automatic Prompt Refinement**: Agent suggests specific prompt changes based on image analysis

5. **Iteration Limits by Chat Type**: Different max iterations for autonomous vs. user-initiated generations

6. **Seed Tracking**: Allow agent to specify seeds for reproducibility across iterations

7. **Dimension Override**: Let agent explicitly set dimensions based on creative intent

## Configuration

### Defaults

- **Max Iterations**: 3 (configurable 1-5)
- **Image Format**: JXL (falls back to WebP thumb)
- **Dimensions**: Auto-analyzed from prompt keywords
- **Model**: Uses chat's configured model for agent review

### Prompt Analysis

Automatic dimension selection based on keywords:
- **Portrait** (1024x1365): "person", "face", "portrait", "character"
- **Landscape** (1365x1024): "scene", "landscape", "environment", "vehicle"
- **Square** (1024x1024): "square", "1:1"

## Example Usage

```typescript
// First iteration
{
  name: "generate_and_review",
  arguments: {
    initialPrompt: "A cyberpunk street scene at night with neon signs",
    creativeIntent: "Moody, atmospheric, lived-in feel with signs of daily life",
    maxIterations: 3
  }
}

// Second iteration (if agent wants to refine)
{
  name: "generate_and_review",
  arguments: {
    initialPrompt: "A cyberpunk street scene at night with neon signs, rain-slicked streets, cluttered storefronts, street food vendors with steam rising",
    creativeIntent: "Moody, atmospheric, lived-in feel with signs of daily life",
    iteration: 2,
    maxIterations: 3,
    imageHistory: [
      { imageUrl: "...", prompt: "...", iteration: 1 }
    ]
  }
}
```

## Notes

- Tool is available only in agent chats (not quick chats)
- Each iteration counts toward the tool loop iteration limit (default 500)
- Images are persisted to `~/.quje-agent/images/` and added to corpus
- Review context includes creative intent to guide agent evaluation
- Agent can accept at any iteration or continue refining until max reached
