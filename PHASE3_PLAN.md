# Phase 3: Server Streaming Service - Implementation Plan

## Overview

Integrate token buffer and TTS streaming into `chat.ts` route to emit `audio_chunk` SSE events.

## Modifications Required

### 1. Import TTS Services

Add to `chat.ts` imports:
```typescript
import { streamTTS, isStreamingCapable } from "./services/tts-streaming.js";
import { getSettings } from "./services/settings.js"; // Get user TTS settings
```

### 2. Wrap Token Stream with TTS

In `handleChatStream`, after line 336 where `eventStream` is created:

```typescript
// Check if TTS streaming is enabled
const settings = await getSettings();
const ttsEnabled = settings.tts?.enabled && settings.tts?.streamingEnabled && 
                   isStreamingCapable(settings.tts.backend);

// Create token stream from LLM
async function* extractTokens() {
  for await (const event of eventStream) {
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        yield ame.delta;
      }
    }
  }
}

// Wrap with TTS if enabled
const audioStream = ttsEnabled 
  ? streamTTS(extractTokens(), settings.tts)
  : null;
```

### 3. Emit audio_chunk Events

In the main event loop (line 337), add parallel processing:

```typescript
// Process LLM events
for await (const event of eventStream) {
  switch (event.type) {
    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        state.fullText += ame.delta;
        state.pendingText += ame.delta;
        res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
      }
      // ... existing handling
      break;
    }
    
    case "tool_execution_start": {
      // Pause TTS on tool execution
      if (ttsEnabled && event.toolName !== "ask_user") {
        // Signal to pause TTS (handled in streamTTS generator)
      }
      // ... existing handling
      break;
    }
  }
}

// Parallel: Emit audio chunks if TTS enabled
if (audioStream) {
  // Run in parallel without blocking LLM events
  (async () => {
    for await (const wavChunk of audioStream) {
      res.write(`event: audio_chunk\ndata: ${JSON.stringify({
        chunkId: crypto.randomUUID(),
        data: wavChunk.toString('base64'),
        mimeType: 'audio/wav',
        sampleRate: 24000,
      })}\n\n`);
    }
  })().catch(err => console.error("[TTS] streaming error:", err));
}
```

### 4. Pause on Tool Execution

Modify `tool_execution_start` case (line 352):

```typescript
case "tool_execution_start": {
  flushTextSegment();
  
  // Signal TTS to pause (via abort controller or generator state)
  if (ttsEnabled && event.toolName !== "ask_user") {
    ttsPauseController?.abort();
  }
  
  // ... rest of existing tool handling
  break;
}
```

### 5. Settings Integration

Create `server/src/services/settings.ts` if not exists:

```typescript
// Simple in-memory settings (can be extended to file/DB later)
let appSettings: any = {};

export async function getSettings() {
  // Load from ~/.quje-agent/settings.json or return defaults
  return appSettings;
}

export async function updateSettings(newSettings: any) {
  appSettings = { ...appSettings, ...newSettings };
  // Persist to disk
}
```

## File Changes

| File | Change | Lines |
|------|--------|-------|
| `chat.ts` | Add TTS imports, wrap token stream, emit audio_chunk | ~50 new |
| `settings.ts` | Create settings service (if needed) | ~30 new |
| `tts-streaming.ts` | Already created in Phase 2 | ✅ |
| `tts-buffer.ts` | Already created in Phase 2 | ✅ |

## Testing

1. Start server with TTS enabled
2. Send message via SSE
3. Verify `audio_chunk` events in stream
4. Test pause on tool execution
5. Test resume after tool completes

## Next: Phase 4

Client-side MediaSource integration to receive and play `audio_chunk` events.

---

**Status**: Ready to implement
