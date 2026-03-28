# Debugging generate_and_review Issues

## What to Look For in Server Logs

When you run `generate_and_review`, watch for these log messages in sequence:

### 1. Tool Execution Starts
```
[generate_and_review] Starting iteration 1/3
[generate_and_review] Generating image with prompt: <your prompt>...
```

### 2. Image Generation Progress
```
[generate-review] Generating for review: <prompt>...
[generate-review] Dimensions: 1024x1365
[generate-review] Linked ComfyUI prompt ID: <uuid>
[generate-review] Generation progress: 5/35
[generate-review] Generation progress: 10/35
...
[generate-review] Generation complete: <imageId>
```

### 3. Tool Result Formatting
```
[generate_and_review] Image generated successfully, formatting review result
[generate_and_review] Returning result with 2 content items (1 images)
```

### 4. Chat Route Receives Result
```
[chat] tool_execution_end: generate_and_review (toolCallId: <uuid>, isError: false)
[chat] Extracted 1 image(s) from tool result <uuid> (generate_and_review)
[chat] Image sizes: 245.3KB
[chat] Tool result accumulated: 1 total
[chat] Tool result segment emitted, waiting for next agent turn...
```

### 5. Agent Turn Ends
```
[chat] turn_end: stopReason=toolUse, toolResults=1, content=0ch
[chat] iter=1 stop=toolUse tools=1 content=0ch thinking=0ch tokens=1234 incomplete=true
[chat] Tool results in turn_end: [{ toolCallId: "...", toolName: "generate_and_review", hasImage: true }]
```

### 6. Agent Should Continue (THIS IS WHERE IT MIGHT HANG)
```
[chat] iter=2 stop=stop tools=0 content=456ch thinking=0ch tokens=2345 incomplete=false
```

## Where It's Getting Stuck

### Scenario A: Hangs at Step 3 or 4
**Symptom:** You see "Image generated successfully" but never see "tool_execution_end"

**Cause:** The tool result is too large (base64 image data in the response)

**Solution:** This shouldn't happen with the current implementation, but if it does, the issue is in the tool execution path. Check for:
- Memory limits
- SSE connection dropping
- Large image sizes (should be ~200-500KB for JXL/WebP)

### Scenario B: Hangs at Step 5
**Symptom:** You see "turn_end" with `stop=toolUse` but no `iter=2`

**Cause:** The agent loop is trying to continue but the LLM is hanging when processing the tool result with the attached image.

**This is the most likely issue.** The image is being attached correctly, but Qwen 3.5 might be:
1. **Struggling with the image size** - Base64-encoded images in tool results can be large
2. **Not properly configured for vision** - Even though Qwen 3.5 supports vision, it needs the right parameters
3. **Getting confused by the content format** - The image is in the tool result content array

**Debug Steps:**

1. **Check if the LLM is actually receiving the image:**
   Look for this log in `agent.ts`:
   ```
   [agent] Attaching 1 image(s) to tool result <uuid> (generate_and_review)
   ```
   If you DON'T see this, the image isn't reaching the LLM.

2. **Check model configuration:**
   ```bash
   ollama show qwen3.5:latest | grep -i vision
   ```
   Should show vision capabilities.

3. **Test vision directly:**
   ```bash
   # Save a generated image temporarily
   cp ~/.quje-agent/images/<uuid>/image.jxl /tmp/test.jxl
   
   # Test if Qwen 3.5 can see it
   ollama run qwen3.5:latest "Describe this image" --image /tmp/test.jxl
   ```

4. **Try a smaller/different vision model:**
   ```bash
   ollama pull llava:7b
   # Then switch your chat to use llava:7b
   ```

### Scenario C: Hangs at Step 6
**Symptom:** You see `iter=2` starts but never completes

**Cause:** The LLM is generating a response but it's taking too long or hitting an error

**Check:**
- Inactivity timeout logs: `[stream] inactivity timeout (900000ms...`
- Error logs: `[chat] continuation loop crashed:`

## Quick Fixes to Try

### 1. Use a Dedicated Vision Model
Even though Qwen 3.5 has vision capabilities, dedicated vision models work better:

```bash
ollama pull llava:7b
# or
ollama pull qwen2-vl:7b
```

Then switch your chat to use that model.

### 2. Reduce Image Size
The current implementation uses the full JXL image. We could resize or use thumbnails for the vision model.

### 3. Check Ollama Memory
If you're running low on VRAM, the model might be swapping:

```bash
nvidia-smi  # Check GPU memory usage
```

### 4. Enable Ollama Debug Logging
```bash
OLLAMA_DEBUG=1 ollama serve
```

Then watch for errors when the agent tries to process the image.

## Expected Behavior

Here's what a successful run looks like:

```
[generate_and_review] Starting iteration 1/3
[generate-review] Generating for review: cyberpunk street scene...
[generate-review] Generation complete: <uuid>
[generate_and_review] Returning result with 2 content items (1 images)
[chat] tool_execution_end: generate_and_review
[chat] Extracted 1 image(s) from tool result
[agent] Attaching 1 image(s) to tool result
[chat] turn_end: stopReason=toolUse, toolResults=1
[chat] iter=2 stop=stop tools=0 content=234ch  ← Agent responds!
```

The agent should then say something like:
> "Here's the first iteration. The neon lighting is great, but the scene feels a bit sterile. Let me add more signs of daily life..."

## If All Else Fails

1. **Check browser console** for any JavaScript errors
2. **Check network tab** for failed SSE connections
3. **Try with a simpler prompt** to rule out prompt complexity issues
4. **Reduce maxIterations to 1** to test the basic flow
5. **Test with a different chat** to rule out chat-specific issues

## Contact Info

If you find the hang is at a specific step, share:
- The exact log output from that step
- Your Ollama model and version
- GPU memory usage during the hang
- Whether the image shows inline in the UI
