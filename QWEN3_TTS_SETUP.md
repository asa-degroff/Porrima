# Qwen3-TTS Setup Guide

## Overview

This guide walks through setting up Qwen3-TTS as an alternative TTS backend for quje-agent, with support for streaming audio generation.

## Prerequisites

- Python 3.10+
- NVIDIA GPU with CUDA (recommended for performance)
- At least 4GB free disk space (model weights ~2GB + cache)
- quje-agent server directory

## Quick Start

### 1. Run Installation Script

```bash
cd /home/asa/quje-agent
./scripts/install-qwen3-tts.sh
```

The script will:
- Install Python packages (`qwen-tts`, `torch`, `soundfile`)
- Download model weights (~2GB)
- Verify installation with test generation

### 2. Verify Installation

```bash
python3 scripts/verify-qwen3-tts.py
```

Expected output:
```
Checking Python imports... ✓
Checking model: Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice... ✓
  Device: cuda:0
  Dtype: torch.bfloat16
Testing generation with speaker 'Ryan'... ✓
  Duration: 2.34s
  Sample rate: 24000 Hz

✓ All checks passed!
```

### 3. Restart Server

```bash
cd server
npm run dev
```

### 4. Test API

```bash
# Check status
curl http://localhost:3001/api/tts/status?backend=qwen3-tts

# List voices
curl http://localhost:3001/api/tts/voices?backend=qwen3-tts

# Generate audio
curl -X POST http://localhost:3001/api/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello from Qwen3!", "voice": "Ryan"}'
```

## Configuration

### TTS Settings

Update TTS settings via API or UI:

```json
{
  "backend": "qwen3-tts",
  "voice": "Ryan",
  "speed": 1.0,
  "streamingEnabled": false,
  "streamingChunkSize": 50,
  "streamingBoundaryTier": "clause"
}
```

### Available Voices

Qwen3-TTS CustomVoice model includes 9 preset voices:

| Voice | Gender | Language | Description |
|-------|--------|----------|-------------|
| Vivian | Female | Chinese | Bright, slightly edgy young female |
| Serena | Female | Chinese | Warm, gentle young female |
| Uncle_Fu | Male | Chinese | Seasoned male, low mellow timbre |
| Dylan | Male | Chinese (Beijing) | Youthful, clear natural |
| Eric | Male | Chinese (Sichuan) | Lively, slightly husky |
| **Ryan** | Male | English | Dynamic, strong rhythmic drive |
| **Aiden** | Male | English | Sunny American, clear midrange |
| Ono_Anna | Female | Japanese | Playful, light nimble |
| Sohee | Female | Korean | Warm, rich emotion |

## Manual Installation (Alternative)

If the script doesn't work, install manually:

### 1. Install Packages

```bash
cd /home/asa/quje-agent/server
source .venv/bin/activate  # if using venv

pip install qwen-tts torch soundfile
```

### 2. Optional: FlashAttention (CUDA only)

```bash
pip install flash-attn --no-build-isolation
```

### 3. Pre-download Model

```bash
python3 -c "from qwen_tts import Qwen3TTSModel; Qwen3TTSModel.from_pretrained('Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice')"
```

### 4. Verify

```bash
python3 scripts/verify-qwen3-tts.py
```

## Troubleshooting

### CUDA Not Available

If running on CPU, generation will be slow. Check CUDA:

```python
import torch
print(torch.cuda.is_available())  # Should print True
print(torch.cuda.get_device_name(0))  # GPU name
```

### Model Download Failed

Clear HuggingFace cache and retry:

```bash
rm -rf ~/.cache/huggingface/hub/Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice
python3 scripts/verify-qwen3-tts.py
```

### Memory Error

Model requires ~4GB VRAM. Reduce precision:

```python
# Edit qwen3_wrapper.py, change dtype to float32
dtype=torch.float32  # instead of bfloat16
```

### Import Error

Ensure packages installed in correct environment:

```bash
# Check which Python is being used
which python3
python3 -c "import sys; print(sys.executable)"

# Reinstall in correct venv
source .venv/bin/activate
pip install --force-reinstall qwen-tts torch soundfile
```

## Performance Benchmarks

| Metric | Kokoro | Qwen3-TTS (0.6B) | Qwen3-TTS (1.7B) |
|--------|--------|------------------|------------------|
| Model Size | ~100MB | ~2GB | ~4GB |
| First Audio Latency | ~500ms | ~200ms | ~300ms |
| Real-time Factor | 0.3x | 0.5x | 0.8x |
| VRAM Usage | ~500MB | ~2GB | ~4GB |
| Streaming Support | ✗ | ✓ | ✓ |

## Next Steps

After Phase 1 (non-streaming backend) is working:

1. **Phase 2**: Implement token buffer algorithm
2. **Phase 3**: Server streaming service
3. **Phase 4**: Client MediaSource integration
4. **Phase 5**: Settings UI
5. **Phase 6**: Testing and optimization

See `IMPLEMENTATION_PLAN_STREAMING_TTS.md` for details.

## Resources

- [Qwen3-TTS GitHub](https://github.com/QwenLM/Qwen3-TTS)
- [HuggingFace Model](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice)
- [Technical Report](https://arxiv.org/abs/2601.15621)
- [quje-agent Implementation Plan](./IMPLEMENTATION_PLAN_STREAMING_TTS.md)
