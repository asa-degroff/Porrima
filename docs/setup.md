# Setup & Deployment

## Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [llama.cpp](https://github.com/ggml-org/llama.cpp) server running locally (default port 32100)
- A chat model loaded in llama.cpp (e.g., a Qwen3 GGUF model in the models directory)
- An embedding model served by llama.cpp (default: `qwen3-embedding:0.6b` on port 32103). Configurable in Settings → Inference Servers → Embedding server.
- (Optional) ComfyUI for image generation
- (Optional) TTS backends installed with `./scripts/install-tts-backend.sh kokoro|qwen3-tts|supertonic-3`

## Setup

```bash
git clone <repo-url> porrima
cd porrima
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

Porrima reserves a contiguous local llama.cpp port block by role:

| Service | Role | Port |
| --- | --- | --- |
| `llama-server.service` | Chat router / GPU inference | 32100 |
| `extraction-model.service` | Memory extraction | 32101 |
| `reranker.service` | Cross-encoder reranking | 32102 |
| `embedding-model.service` | Vector embeddings | 32103 |
| `title-generation.service` | Titles and recaps | 32104 |

### Main Server

Create `~/.config/systemd/user/porrima.service`:

```ini
[Unit]
Description=Porrima Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/porrima/server
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=ORIGIN=http://localhost:3001
Environment=RP_ID=localhost

[Install]
WantedBy=default.target
```

For remote access, replace `ORIGIN` and `RP_ID` with the final HTTPS browser origin and hostname before registering passkeys, for example `ORIGIN=https://porrima.example.com` and `RP_ID=porrima.example.com`.

On first run, Porrima prints the raw owner setup token to the `porrima.service` journal and stores only hash/state metadata at `~/.porrima/auth/setup-token.txt`. Read the raw token with `journalctl --user -u porrima.service`; do not paste the `tokenSha256` value from the file into the browser. The setup token expires after 30 minutes, locks after 10 failed attempts, and is removed after the first successful owner passkey registration.

### Binary Symlink (Recommended)

Porrima manages llama.cpp builds through a `llama-current` symlink. Place your llama.cpp build directories under `~/bin/` (e.g. `~/bin/llama-b9500/`) and create the symlink:

```bash
ln -sfn ~/bin/llama-b9500 ~/bin/llama-current
```

All five llama.cpp services reference `~/bin/llama-current/llama-server` by default. To update to a new build, just swap the symlink and restart services — or use the Settings → Inference Servers → Binary Path panel, which handles the swap, service restart, and automatic rollback on failure.

Custom binaries (e.g. a fork with dynamic `.so` libraries) can be set per-slot in Settings. Porrima auto-injects `LD_LIBRARY_PATH` pointing to the custom binary's directory.

### llama.cpp Server (Optional)

For direct GGUF inference with router mode. Create `~/.config/systemd/user/llama-server.service`:

```ini
[Unit]
Description=llama.cpp Server (router mode)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/asa/bin/llama-current
ExecStart=/home/asa/bin/llama-current/llama-server \
    --models-dir ~/.local/share/llama-models \
    --port 32100 --host 127.0.0.1 \
    --ctx-size 131072 --parallel 1 \
    --n-gpu-layers auto \
    --reasoning-format deepseek \
    --sleep-idle-seconds 172800
Environment=LD_LIBRARY_PATH=/home/asa/bin/llama-current
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

For cross-encoder memory reranking. Download `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` (or another reranker model — the model identifier is configurable in Settings → Inference Servers → Reranker), then create `~/.config/systemd/user/reranker.service`:

```ini
[Unit]
Description=Qwen3 Reranker (CPU-only)
After=network-online.target

[Service]
Type=simple
ExecStart=/home/asa/bin/llama-current/llama-server \
    -m /path/to/qwen3-reranker-0.6b-q8_0.gguf \
    --alias qwen3-reranker \
    --embedding --pooling rank --reranking \
    --port 32102 --host 127.0.0.1 \
    --n-gpu-layers 0 --ctx-size 4096
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

The `--alias` flag must match the **Model name** configured in Settings — the reranker client sends that string as the `model` field in `/v1/rerank` requests.

### Embedding Service (llama.cpp backend)

The embedding service runs as a dedicated llama.cpp server with `--embeddings` on its own port:

```ini
[Unit]
Description=llama.cpp Embedding Server
After=network-online.target

[Service]
Type=simple
ExecStart=/home/asa/bin/llama-current/llama-server \
    -m /path/to/qwen3-embedding-0.6b.gguf \
    --alias qwen3-embedding \
    --embeddings --pooling cls \
    --port 32103 --host 127.0.0.1 \
    --n-gpu-layers 0 --ctx-size 8192
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Then in Settings → Inference Servers → Embedding server, switch the provider toggle to **llama.cpp**, point the URL at `http://localhost:32103`, and set the model name to match `--alias`.

### Changing the embedding model

Embeddings from different models are not comparable — existing memory searches will return poor results until all vectors are regenerated. To switch models safely:

1. Open Settings → Inference Servers → Embedding server → Migration & Backups.
2. Click **Back up now** (optionally with a label). This writes `memories.db` and `corpus.db` under `~/.porrima/backups/<timestamp>/`.
3. Change the provider / URL / model to the new embedding config and save.
4. Click **Re-embed all memories & corpus**. The UI shows progress; the operation may take several minutes for large stores and the chat is unavailable while vectors are being rewritten.
5. If anything goes wrong, the backup can be restored from the same panel (the restored config will also overwrite your current embedding settings).

### Enable Services

```bash
systemctl --user daemon-reload
systemctl --user enable --now porrima llama-server reranker
loginctl enable-linger $USER   # start without login
```
