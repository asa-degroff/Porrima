# generate_and_review Tool

## Overview

The `generate_and_review` tool enables iterative image generation with built-in agent review. The agent can generate an image, evaluate it against a creative intent, and optionally retry with refined prompts—up to a maximum number of iterations.

## Usage

### Basic Call

```typescript
{
  "name": "generate_and_review",
  "arguments": {
    "initialPrompt": "A cyberpunk street scene at night with neon signs",
    "creativeIntent": "Create a moody, atmospheric cyberpunk scene that feels lived-in and authentic, not just aesthetic. Should have a sense of daily life continuing despite the high-tech surroundings.",
    "maxIterations": 3
  }
}
```

### How It Works

1. **Generation**: The tool generates an image using ComfyUI with the provided prompt
2. **Attachment**: The generated image is attached to the tool result as base64 data
3. **Review Context**: The tool provides structured review context including:
   - Creative intent
   - Current prompt
   - Iteration count
   - Previous attempts (if any)
4. **Agent Evaluation**: The agent sees the image and evaluates it against the intent
5. **Decision**: The agent can either:
   - Accept the image (tool loop continues or ends)
   - Call `generate_and_review` again with a refined prompt (counts toward max iterations)

### Iteration Flow

```
User: "Generate a cyberpunk scene"
  ↓
Agent calls generate_and_review (iteration 1/3)
  ↓
Tool generates image, returns with image attached
  ↓
Agent evaluates: "The neon is good but it feels too sterile"
  ↓
Agent calls generate_and_review (iteration 2/3)
  Arguments: {
    initialPrompt: "A cyberpunk street scene at night with neon signs, rain-slicked streets, cluttered storefronts, visible wear and tear, street food vendors",
    creativeIntent: "...",
    iteration: 2,
    imageHistory: [...]
  }
  ↓
Tool generates new image with refined prompt
  ↓
Agent evaluates: "Much better, captures the lived-in feel"
  ↓
Agent accepts, continues with normal response
```

## Implementation Details

### Server-Side (`server/src/services/generate-review.ts`)

- `generateForReview()`: Generates image via ComfyUI, returns base64 for attachment
- `buildReviewContext()`: Creates structured evaluation prompt for the agent
- `formatReviewResult()`: Formats tool result with text + image attachment

### Tool Definition (`server/src/services/agent-tools.ts`)

The tool:
- Accepts `initialPrompt`, `creativeIntent`, `maxIterations`
- Tracks `iteration` and `imageHistory` across calls
- Returns image as `{ type: "image", data: base64, mimeType: "image/jxl" }`
- Includes review context in the text response

### Client-Side (`client/src/components/ToolCallDisplay.tsx`)

- Renders generated images inline when tool result includes `images` array
- Uses `UserImage` component for display
- Images appear in expanded tool call view

### Message Reconstruction (`server/src/services/agent.ts`)

- Tool results with images are converted to pi-ai `ToolResultMessage` with image content
- Images are attached alongside text: `content: [{ type: "text", ... }, { type: "image", ... }]`

### Chat Route (`server/src/routes/chat.ts`)

- Extracts images from tool result content
- Adds to `ChatToolResult.images` array
- Persists with the message for later reconstruction

## Configuration

### Default Settings

- **Max Iterations**: 3 (configurable 1-5)
- **Image Format**: JXL (falls back to WebP thumb)
- **Dimensions**: Auto-analyzed from prompt (portrait/landscape/square)

### Dimension Analysis

The tool automatically adjusts dimensions based on prompt keywords:
- **Portrait** (1024x1365): "person", "face", "portrait", "character"
- **Landscape** (1365x1024): "scene", "landscape", "environment", "vehicle"
- **Square** (1024x1024): "square", "1:1"

## Best Practices

### Writing Creative Intent

Good creative intent is specific about:
- **Mood/Atmosphere**: "moody", "uplifting", "tense"
- **Emotional Goal**: "feels lived-in", "sense of wonder", "unsettling"
- **What to Avoid**: "not just aesthetic", "avoid clichés"

### Refining Prompts

When iterating:
1. **Be specific** about what's missing: "needs more clutter", "lighting too flat"
2. **Add concrete details**: "rain-slicked streets", "neon reflections", "steam vents"
3. **Reference the image**: "the composition is good but the colors are too saturated"

### When to Use

- **Autonomous generation**: Agent explores creative directions independently
- **User requests**: "Generate X and make sure it captures Y"
- **Iterative refinement**: When the first result isn't quite right

## Example Agent Flow

```
Agent: I'll generate that cyberpunk scene for you.
[Tool Call: generate_and_review]
  initialPrompt: "A cyberpunk street scene at night with neon signs"
  creativeIntent: "Moody, atmospheric, lived-in feel"
  maxIterations: 3

[Tool Result: Generation complete, image attached]
Agent: Here's the first attempt. The neon is striking, but it feels a bit sterile—like a concept art piece rather than a real place. Let me refine it to add more signs of daily life.

[Tool Call: generate_and_review]
  initialPrompt: "A cyberpunk street scene at night with neon signs, rain-slicked streets, cluttered storefronts with handwritten signs, street food vendors with steam rising, visible wear and tear on buildings, tangled cables overhead"
  creativeIntent: "Moody, atmospheric, lived-in feel"
  iteration: 2
  imageHistory: [...]

[Tool Result: Generation complete, image attached]
Agent: Much better. The steam from the food vendor, the handwritten signs, the tangled cables—these details make it feel like a real place where people actually live. This captures the intent.

Here's your cyberpunk scene with that authentic, lived-in atmosphere you wanted.
```

## Future Enhancements

Potential improvements:
- **Vision model review**: Use a vision model to automatically evaluate generated images against intent
- **Automatic refinement**: Agent suggests prompt refinements based on image analysis
- **Comparison view**: Show all iterations side-by-side for final selection
- **Batch generation**: Generate multiple variations in parallel, then select best
