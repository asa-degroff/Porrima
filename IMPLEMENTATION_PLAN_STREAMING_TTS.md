# Streaming TTS Implementation Plan

## Executive Summary

This document outlines the complete implementation plan for adding streaming TTS support to porrima using Qwen3-TTS. The architecture enables the agent to speak *while* streaming tokens, not after generation completes.

**Key assumption**: Users run recent Chrome/Firefox/Safari versions with MediaSource API support. No legacy fallbacks needed.

---

## 1. Token Buffer Algorithm (Deep Dive)

### 1.1 Three-Tier Boundary Detection

Based on Deepgram's TTS chunking research and NLTK documentation:

```
┌─────────────────────────────────────────────────────────────┐
│                    Boundary Hierarchy                        │
├─────────────────────────────────────────────────────────────┤
│ Tier 1: Word (minimum)   → whitespace or punctuation        │
│ Tier 2: Clause (preferred) → commas + FANBOYS, semicolons   │
│ Tier 3: Sentence (ideal)   → NLTK sent_tokenize             │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Performance Characteristics

| Method | Latency | Quality | Use Case |
|--------|---------|---------|----------|
| Word boundary | ~50ms | Choppy | Fallback only |
| Clause regex | ~1ms | Good | Default |
| NLTK sentence | ~5ms | Best | Long-form content |

**Key insight**: NLTK's `sent_tokenize()` has had performance regressions (15s for 1M chars), but for streaming TTS we're processing 30-80 token chunks (~200-500 chars), where it's sub-millisecond.

### 1.3 Implementation: `StreamingTokenBuffer`

```typescript
// server/src/services/tts-buffer.ts

import { sent_tokenize } from 'nltk';

interface BoundaryResult {
  shouldEmit: boolean;
  reason: 'word' | 'clause' | 'sentence' | 'max-length';
  chunkText: string;
}

class StreamingTokenBuffer {
  private tokens: string[] = [];
  private readonly MIN_TOKENS = 30;   // ~1-2 seconds speech
  private readonly MAX_TOKENS = 80;   // ~4-5 seconds speech
  private readonly MAX_CHARS = 500;   // safety limit
  
  // Clause boundary regex (FANBOYS + punctuation)
  private readonly CLAUSE_REGEX = /[.!?,;:]$|, (and|but|or|nor|for|yet|so)$/;
  
  push(token: string): void {
    this.tokens.push(token);
  }
  
  checkBoundary(): BoundaryResult {
    const text = this.tokens.join('');
    const lastToken = this.tokens[this.tokens.length - 1];
    
    // Tier 1: Word boundary (always required)
    const isWordBoundary = /\s$/.test(lastToken) || /[.!?,;:]$/.test(lastToken);
    
    if (!isWordBoundary) {
      return { shouldEmit: false, reason: 'word', chunkText: '' };
    }
    
    // Check max length (emergency flush)
    if (this.tokens.length >= this.MAX_TOKENS || text.length >= this.MAX_CHARS) {
      return { shouldEmit: true, reason: 'max-length', chunkText: text };
    }
    
    // Check min length (don't emit too small chunks)
    if (this.tokens.length < this.MIN_TOKENS) {
      return { shouldEmit: false, reason: 'word', chunkText: '' };
    }
    
    // Tier 2: Clause boundary (preferred for streaming)
    if (this.CLAUSE_REGEX.test(text)) {
      return { shouldEmit: true, reason: 'clause', chunkText: text };
    }
    
    // Tier 3: Sentence boundary (best prosody, slightly higher latency)
    try {
      const sentences = sent_tokenize(text);
      if (sentences.length > 1) {
        // We have complete sentence(s)
        return { shouldEmit: true, reason: 'sentence', chunkText: sentences[0] };
      }
    } catch (e) {
      // NLTK not loaded, fall back to clause detection
    }
    
    return { shouldEmit: false, reason: 'word', chunkText: '' };
  }
  
  flush(): string {
    const text = this.tokens.join('');
    this.tokens = [];
    return text;
  }
  
  // CJK language support (no spaces)
  checkBoundaryCJK(): BoundaryResult {
    const text = this.tokens.join('');
    const charCount = text.length;
    
    if (charCount >= 50) {  // ~2-3 seconds for Chinese
      return { shouldEmit: true, reason: 'max-length', chunkText: text };
    }
    
    if (/[.!?,;.!]/.test(text)) {  // CJK punctuation
      return { shouldEmit: true, reason: 'clause', chunkText: text };
    }
    
    return { shouldEmit: false, reason: 'word', chunkText: '' };
  }
}
```

### 1.4 NLTK Initialization

```python
# server/src/services/tts-worker.py

import nltk
try:
    nltk.data.load('tokenizers/punkt/english.pickle')
except LookupError:
    nltk.download('punkt', quiet=True)

# Pre-load tokenizer on startup (avoid first-call latency)
from nltk.tokenize import sent_tokenize
sent_tokenize("Warmup sentence.")  # Forces model load
```

---

## 2. Server Architecture

### 2.1 File Structure

```
server/src/services/
├── tts.ts                  # Refactored: TTSBackend interface
├── tts-streaming.ts        # NEW: Qwen3-TTS streaming service
├── tts-buffer.ts           # NEW: Token buffer algorithm
├── tts-worker.py           # Modified: Generator-based output
└── tts-worker-streaming.py # NEW: Streaming-specific worker
```

### 2.2 TTS Backend Interface

```typescript
// server/src/services/tts.ts

interface TTSBackend {
  generate(text: string, options: TTSOptions): Promise<Buffer>;
  stream?(text: AsyncIterable<string>, options: TTSOptions): AsyncGenerator<Buffer>;
  isStreamingCapable(): boolean;
}

class KokoroBackend implements TTSBackend {
  async generate(text: string, options: TTSOptions): Promise<Buffer> {
    // Existing implementation - complete WAV file
  }
  
  isStreamingCapable(): boolean {
    return false;
  }
}

class Qwen3TTSBackend implements TTSBackend {
  private model: any; // Qwen3TTSModel from Python subprocess
  
  constructor() {
    this.model = new Qwen3TTSModel({
      modelPath: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
      device: 'cuda',
      dtype: 'bfloat16'
    });
  }
  
  async generate(text: string, options: TTSOptions): Promise<Buffer> {
    // Non-streaming fallback
    return await this.model.generate_custom_voice(text, options);
  }
  
  async *stream(text: AsyncIterable<string>, options: TTSOptions): AsyncGenerator<Buffer> {
    const buffer = new StreamingTokenBuffer();
    
    for await (const token of text) {
      buffer.push(token);
      
      const result = buffer.checkBoundary();
      if (result.shouldEmit) {
        const chunkText = result.chunkText;
        buffer.flush();
        
        const wav = await this.model.generate_custom_voice(chunkText, options);
        yield wav; // Complete WAV with header
      }
    }
    
    // Flush remaining
    if (buffer.tokens.length > 0) {
      const wav = await this.model.generate_custom_voice(buffer.flush(), options);
      yield wav;
    }
  }
  
  isStreamingCapable(): boolean {
    return true;
  }
}
```

### 2.3 Chat Route Integration

```typescript
// server/src/routes/chat.ts (modified sections)

async function *handleChatStream(chatId: string, message: string, settings: Settings) {
  const ttsBackend = settings.tts.backend === 'qwen3-tts' 
    ? new Qwen3TTSBackend() 
    : new KokoroBackend();
  
  const tokenBuffer = new StreamingTokenBuffer();
  const ttsEnabled = settings.tts.enabled && settings.tts.streamingEnabled;
  
  // Create async generator for token stream
  async function *llmTokenStream() {
    const piMessages = await buildPiMessages(chatId);
    const stream = await streamChat(piMessages, modelId);
    
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') {
        yield chunk.content;
        yield SSEvent('text_delta', chunk.content);
      } else if (chunk.type === 'thinking_delta') {
        yield SSEvent('thinking_delta', chunk.content);
      }
    }
  }
  
  // TTS streaming generator
  async function *ttsStream() {
    if (!ttsEnabled || !ttsBackend.isStreamingCapable()) return;
    
    for await (const wavChunk of ttsBackend.stream(llmTokenStream(), settings.tts)) {
      const base64 = wavChunk.toString('base64');
      yield SSEvent('audio_chunk', {
        chunkId: crypto.randomUUID(),
        data: base64,
        mimeType: 'audio/wav',
        sampleRate: 24000,
        duration: wavChunk.length / 24000 / 2, // rough estimate
        text: tokenBuffer.flush()
      });
    }
  }
  
  // Pause on tool execution
  let toolExecutionInProgress = false;
  
  eventEmitter.on('tool_status', (status) => {
    toolExecutionInProgress = (status === 'running');
    if (toolExecutionInProgress) {
      tokenBuffer.flush(); // discard partial buffer
    }
  });
  
  // Main streaming loop
  for await (const event of ttsStream()) {
    if (!toolExecutionInProgress) {
      yield event;
    }
  }
}
```

### 2.4 Python Worker (Streaming)

```python
#!/usr/bin/env python3
# server/src/services/tts-worker-streaming.py

import sys
import json
import torch
from qwen_tts import Qwen3TTSModel

# Initialize on startup
model = Qwen3TTSModel.from_pretrained(
    "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    device_map="cuda:0",
    dtype=torch.bfloat16,
    attn_implementation="flash_attention_2"
)

def stream_audio_generator(text_chunks, speaker, instruct):
    """Generator that yields WAV chunks (with headers)"""
    for chunk_text in text_chunks:
        wavs, sr = model.generate_custom_voice(
            text=chunk_text,
            speaker=speaker,
            instruct=instruct
        )
        # wavs is already WAV format with header
        sys.stdout.buffer.write(wavs.tobytes())
        sys.stdout.buffer.flush()

if __name__ == '__main__':
    config = json.loads(sys.argv[1])
    stream_audio_generator(
        config['chunks'],
        config['speaker'],
        config['instruct']
    )
```

---

## 3. Client Architecture

### 3.1 MediaSource Integration

```typescript
// client/src/hooks/useStreamingTTS.ts

export function useStreamingTTS() {
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  
  // Initialize MediaSource on mount
  useEffect(() => {
    if (!settings.tts.streamingEnabled) return;
    
    const ms = new MediaSource();
    const audio = new Audio();
    audio.src = URL.createObjectURL(ms);
    audioRef.current = audio;
    
    ms.addEventListener('sourceopen', () => {
      if (MediaSource.isTypeSupported('audio/wav; codecs=pcm')) {
        const sb = ms.addSourceBuffer('audio/wav; codecs=pcm');
        sb.mode = 'sequence'; // Critical: tells MSE chunks are sequential
        
        sb.addEventListener('updateend', () => {
          if (!ms.ended && audio.paused && !isPaused) {
            audio.play().catch(console.error);
          }
        });
        
        sb.addEventListener('error', (e) => {
          console.error('SourceBuffer error:', e);
        });
        
        sourceBufferRef.current = sb;
        setIsReady(true);
      } else {
        console.warn('WAV/PCM not supported');
        setIsReady(false);
      }
    });
    
    mediaSourceRef.current = ms;
    
    return () => {
      ms.endOfStream();
      audio.pause();
      URL.revokeObjectURL(audio.src);
    };
  }, [settings.tts.streamingEnabled]);
  
  // Append WAV chunk (includes 44-byte header)
  const appendChunk = useCallback((base64Wav: string) => {
    const sb = sourceBufferRef.current;
    if (!sb || sb.updating || isPaused) return;
    
    try {
      const binary = atob(base64Wav);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      sb.appendBuffer(bytes);
    } catch (err) {
      console.error('Failed to append audio chunk:', err);
    }
  }, [isPaused]);
  
  // Pause on tool execution
  useEffect(() => {
    const eventSource = new EventSource(`/api/chat/${chatId}`);
    
    eventSource.addEventListener('tool_status', (e) => {
      const { status } = JSON.parse(e.data);
      if (status === 'running') {
        audioRef.current?.pause();
        setIsPaused(true);
        // Clear buffer to avoid stale chunks
        if (sourceBufferRef.current) {
          sourceBufferRef.current.abort();
        }
      } else if (status === 'done') {
        setIsPaused(false);
      }
    });
    
    eventSource.addEventListener('done', () => {
      mediaSourceRef.current?.endOfStream();
    });
    
    return () => eventSource.close();
  }, [chatId]);
  
  return { 
    mediaSource: mediaSourceRef.current, 
    appendChunk, 
    isReady, 
    isPaused,
    audio: audioRef.current 
  };
}
```

### 3.2 MessageBubble Integration

```typescript
// client/src/components/MessageBubble.tsx

import { useStreamingTTS } from '../hooks/useStreamingTTS';

export function MessageBubble({ message, isStreaming }: Props) {
  const { appendChunk, isReady, isPaused } = useStreamingTTS();
  
  useEffect(() => {
    if (!isStreaming || !settings.tts.streamingEnabled) return;
    
    const eventSource = new EventSource(`/api/chat/${chatId}`);
    
    eventSource.addEventListener('audio_chunk', (e) => {
      const { data } = JSON.parse(e.data);
      appendChunk(data.data); // base64 WAV
    });
    
    return () => eventSource.close();
  }, [chatId, isStreaming, appendChunk]);
  
  // Render message content...
}
```

---

## 4. Settings & Configuration

### 4.1 Extended TTSSettings Interface

```typescript
// server/src/types.ts

interface TTSSettings {
  enabled: boolean;
  backend: 'kokoro' | 'qwen3-tts';
  streamingEnabled: boolean;      // NEW
  streamingChunkSize: number;     // NEW: 30-80 tokens
  streamingBoundaryTier: 'clause' | 'sentence'; // NEW
  voice: string;
  speed: number;
  pitch: number;
  autoRead: boolean;
}
```

### 4.2 Settings UI

```typescript
// client/src/components/SettingsPanel.tsx

<div className="space-y-4">
  <Toggle 
    label="Enable TTS" 
    checked={settings.tts.enabled}
    onChange={(v) => updateSettings({ tts: { ...settings.tts, enabled: v }})}
  />
  
  {settings.tts.enabled && (
    <>
      <Select
        label="TTS Backend"
        value={settings.tts.backend}
        options={[
          { value: 'kokoro', label: 'Kokoro (Standard)' },
          { value: 'qwen3-tts', label: 'Qwen3-TTS (Streaming)' }
        ]}
        onChange={(v) => updateSettings({ tts: { ...settings.tts, backend: v }})}
      />
      
      {settings.tts.backend === 'qwen3-tts' && (
        <>
          <Toggle
            label="Streaming Mode"
            checked={settings.tts.streamingEnabled}
            onChange={(v) => updateSettings({ tts: { ...settings.tts, streamingEnabled: v }})}
          />
          
          {settings.tts.streamingEnabled && (
            <>
              <Slider
                label="Chunk Size (tokens)"
                min={30}
                max={80}
                value={settings.tts.streamingChunkSize}
                onChange={(v) => updateSettings({ tts: { ...settings.tts, streamingChunkSize: v }}})
              />
              
              <Select
                label="Boundary Detection"
                value={settings.tts.streamingBoundaryTier}
                options={[
                  { value: 'clause', label: 'Clause (faster)' },
                  { value: 'sentence', label: 'Sentence (better prosody)' }
                ]}
                onChange={(v) => updateSettings({ tts: { ...settings.tts, streamingBoundaryTier: v }})}
              />
            </>
          )}
        </>
      )}
    </>
  )}
</div>
```

---

## 5. Implementation Phases

### Phase 1: Qwen3-TTS Non-Streaming Backend (1-2 days)
- Install `qwen-tts` Python package
- Create `Qwen3TTSBackend` class implementing `TTSBackend` interface
- Add model download + initialization on server startup
- Test non-streaming generation (drop-in for Kokoro)
- **Deliverable**: Qwen3-TTS works as alternative backend

### Phase 2: Token Buffer Algorithm (1 day)
- Implement `StreamingTokenBuffer` class
- Integrate NLTK sentence tokenizer
- Unit tests for boundary detection
- Benchmark latency (target: <5ms per check)
- **Deliverable**: Buffer correctly emits at clause/sentence boundaries

### Phase 3: Server Streaming Service (2 days)
- Create `tts-streaming.ts` with generator-based streaming
- Modify `chat.ts` route to support `audio_chunk` SSE events
- Implement pause/resume on tool execution
- Test end-to-end streaming (server → SSE)
- **Deliverable**: Server emits `audio_chunk` events during token stream

### Phase 4: Client MediaSource Integration (2 days)
- Implement `useStreamingTTS` hook
- Wire `audio_chunk` event handler in `MessageBubble`
- Add pause/resume logic on `tool_status` events
- Test playback in Chrome/Firefox/Safari
- **Deliverable**: Audio plays incrementally as chunks arrive

### Phase 5: Settings UI + Polish (1 day)
- Add streaming toggles to settings panel
- Persist `streamingEnabled`, `streamingChunkSize`, `streamingBoundaryTier`
- Add loading states, error handling
- **Deliverable**: User can toggle streaming on/off

### Phase 6: Testing + Optimization (2 days)
- Load testing (concurrent streams)
- Latency measurement (token → audio)
- Memory profiling (SourceBuffer cleanup)
- Cross-browser testing
- **Deliverable**: Production-ready streaming TTS

**Total**: 8-10 days

---

## 6. Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| First audio latency | <500ms | Token emitted → first chunk played |
| Chunk generation | <200ms | Text chunk → WAV buffer |
| Boundary detection | <5ms | Token push → boundary check |
| Memory per stream | <50MB | SourceBuffer + audio elements |
| Concurrent streams | 10+ | Load test with multiple chats |

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| NLTK first-call latency | Medium | High | Pre-load on server startup |
| SourceBuffer memory leak | Low | High | Call `abort()` on conversation end |
| Browser MSE incompatibility | Low | Medium | Assume modern browsers (per user base) |
| Qwen3-TTS model download fail | Medium | High | Cache model weights, retry logic |
| Audio chunk ordering issues | Low | Medium | Use `sequence` mode + chunkId tracking |

---

## 8. Testing Strategy

### Unit Tests
- `StreamingTokenBuffer` boundary detection
- `Qwen3TTSBackend` generation
- `useStreamingTTS` hook logic

### Integration Tests
- End-to-end streaming (LLM → TTS → SSE → Client)
- Pause/resume on tool execution
- Settings persistence

### Load Tests
- 10 concurrent streaming chats
- Memory profiling over 1-hour session
- Network bandwidth (base64 overhead ~33%)

---

## 9. Success Criteria

✅ Agent speaks *while* generating tokens (not after)  
✅ Audio pauses during tool execution  
✅ No audible gaps between chunks  
✅ Settings toggle works (streaming on/off)  
✅ Latency <500ms token-to-audio  
✅ Works on Chrome 90+, Firefox, Safari  

---

## 10. Next Steps

1. **Start Phase 1**: Install Qwen3-TTS, verify non-streaming generation
2. **Pre-load NLTK**: Add tokenizer warmup on server startup
3. **Draft `StreamingTokenBuffer`**: Implement boundary detection
4. **Review with user**: Confirm architecture before Phase 3

---

**Document Version**: 1.0  
**Last Updated**: 2026-03-16  
**Author**: Porrima
