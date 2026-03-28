# generate_and_review Troubleshooting

## Issue: Agent Doesn't See the Image

If the agent isn't reviewing the image or mentioning it, the model likely doesn't support vision.

### Required: Vision-Capable Model

The `generate_and_review` tool requires a **vision-capable model** to see the generated images. 

**Recommended models:**
- `llava:7b` or `llava:13b` (best for vision tasks)
- `bakllava:7b`
- `moondream:1.8b` (lightweight)
- `qwen2-vl:7b` (excellent vision capabilities)

**Models that DON'T work:**
- `qwen3:8b` (text-only, despite reasoning capabilities)
- `llama3.2:3b` (text-only variant)
- `mistral:7b` (text-only)

### How to Check Your Model

1. Look at the server logs when the tool runs:
   ```
   [agent] Attaching 1 image(s) to tool result <uuid> (generate_and_review)
   ```
   If you see this, the image is being attached correctly.

2. Check if your model supports vision in Ollama:
   ```bash
   ollama show <model-name> | grep -i vision
   ```

3. Test vision capability directly:
   ```bash
   ollama run llava:7b "Describe this image" --image /path/to/image.jpg
   ```

### Solution

Pull a vision-capable model and switch your chat to use it:

```bash
# Pull llava (recommended)
ollama pull llava:7b

# Or qwen2-vl (excellent vision)
ollama pull qwen2-vl:7b
```

Then in the UI, change the model selector for your chat to use the vision model.

## Issue: Image Not Showing Inline

If the image shows when you expand the tool call but not inline:

1. **Check browser console** for errors loading the image
2. **Verify the image data** is being extracted (see server logs above)
3. **Clear browser cache** and reload

The image should appear automatically below the tool call header for `generate_and_review` tool.

## Debug Checklist

Run through this checklist if the tool isn't working:

- [ ] Server logs show `[chat] Extracted 1 image(s) from tool result`
- [ ] Server logs show `[agent] Attaching 1 image(s) to tool result`
- [ ] Using a vision-capable model (llava, qwen2-vl, etc.)
- [ ] Image appears when tool call is expanded
- [ ] No errors in browser console
- [ ] ComfyUI generation completed successfully

## Example Working Flow

```
User: Generate a cyberpunk street scene with a lived-in feel
  ↓
Agent: I'll use generate_and_review to create this
  ↓
[Tool Call] generate_and_review
  initialPrompt: "cyberpunk street scene..."
  creativeIntent: "lived-in, authentic feel"
  ↓
[Server Log] [chat] Extracted 1 image(s) from tool result abc123
[Server Log] [agent] Attaching 1 image(s) to tool result abc123
  ↓
[UI] Tool call shows with image inline (not requiring expansion)
  ↓
Agent: Here's the first attempt. The neon is good but it feels sterile...
  ↓
[Tool Call] generate_and_review (iteration 2)
  initialPrompt: "cyberpunk street scene with rain, vendors, clutter..."
  ↓
Agent: Much better! This captures the lived-in atmosphere.
```

## Common Mistakes

1. **Using text-only model**: The agent literally cannot see the image
2. **Not waiting for generation**: Image generation takes 30-60 seconds
3. **Wrong expectations**: Agent may accept first image if it's "good enough"

## Performance Notes

- Image generation: 30-90 seconds depending on GPU
- Vision analysis: 5-15 seconds with llava
- Each iteration adds to context window (watch token usage)
