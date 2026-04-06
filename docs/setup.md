# Setup & Deployment

## Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [Ollama](https://ollama.ai/) running locally on port 11434
- A chat model pulled in Ollama (e.g. `ollama pull qwen3:8b`)
- The embedding model for memory: `ollama pull qwen3-embedding:0.6b`
- **Creative Engine**: `ollama pull qwen3.5:9b` (recommended for direction generation with vision context)
- (Optional) [llama.cpp](https://github.com/ggml-org/llama.cpp) server for direct GGUF inference with router mode
- (Optional) ComfyUI for image generation
- (Optional) Kokoro TTS voices or Qwen3-TTS

## Setup

```bash
git clone <repo-url> quje-agent
cd quje-agent
npm install
```

## Development

Run the server and client in separate terminals:

```bash
# Terminal 1 — backend (port 3001)
cd server
npm run dev

# Terminal 2 — frontend (port 5173)
cd client
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` requests to the backend.

## Production

Build and run:

```bash
cd server && npm run build
cd ../client && npm run build
cd ../server && npm start
```

The compiled server serves on port 3001. Serve the client build (`client/dist/`) with any static file server, or set up a reverse proxy.

## systemd Services

### Main Server

Create `~/.config/systemd/user/quje-agent.service`:

```ini
[Unit]
Description=qu.je Agent Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/quje-agent/server
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

### llama.cpp Server (Optional)

For direct GGUF inference with router mode. Create `~/.config/systemd/user/llama-server.service`:

```ini
[Unit]
Description=llama.cpp Server (router mode)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/llama.cpp/build
ExecStart=/path/to/llama-server \
    --models-dir ~/.local/share/llama-models \
    --port 8080 --host 127.0.0.1 \
    --ctx-size 131072 --parallel 1 \
    --n-gpu-layers auto \
    --reasoning-format deepseek \
    --sleep-idle-seconds 300
Environment=LD_LIBRARY_PATH=/path/to/llama.cpp/build
# For AMD GPUs:
Environment=HSA_OVERRIDE_GFX_VERSION=11.0.0
Environment=ROCR_VISIBLE_DEVICES=0,1
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

**Model directory structure**: Place models in `~/.local/share/llama-models/` as subdirectories. Each subdirectory contains the model GGUF + optional `mmproj*.gguf` for vision support:
```
~/.local/share/llama-models/
├── Qwen3.5-27B-Q4_K_M/
│   ├── Qwen3.5-27B-Q4_K_M.gguf
│   └── mmproj-F16.gguf          # auto-detected for vision
└── gemma-4-26B-Q4_K_M/
    ├── gemma-4-26B-Q4_K_M.gguf
    └── mmproj-BF16.gguf
```

**Auto-sync from HuggingFace**: After downloading models via `llama-server -hf`, run `~/bin/sync-llama-models.sh` or enable the timer:
```bash
systemctl --user enable --now sync-llama-models.timer
```

### Reranker Service (Optional)

For cross-encoder memory reranking. Download `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF`, then create `~/.config/systemd/user/reranker.service`:

```ini
[Unit]
Description=Qwen3 Reranker (CPU-only)
After=network-online.target

[Service]
Type=simple
ExecStart=/path/to/llama-server \
    -m /path/to/qwen3-reranker-0.6b-q8_0.gguf \
    --embedding --pooling rank --reranking \
    --port 8082 --host 127.0.0.1 \
    --n-gpu-layers 0 --ctx-size 4096
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

### Enable Services

```bash
systemctl --user daemon-reload
systemctl --user enable --now quje-agent llama-server reranker
loginctl enable-linger $USER   # start without login
```
