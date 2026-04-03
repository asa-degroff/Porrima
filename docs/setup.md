# Setup & Deployment

## Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [Ollama](https://ollama.ai/) running locally on port 11434
- A chat model pulled in Ollama (e.g. `ollama pull qwen3:8b`)
- The embedding model for memory: `ollama pull qwen3-embedding:0.6b`
- **Creative Engine**: `ollama pull qwen3.5:9b` (recommended for direction generation with vision context)
- (Optional) ComfyUI for image generation
- (Optional) Kokoro TTS voices or Qwen3-TTS
- (Optional) llama.cpp server for OpenAI-compatible inference

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

## systemd Service

To run the server on boot, create `~/.config/systemd/user/quje-agent.service`:

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

Then enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now quje-agent
loginctl enable-linger $USER   # start without login
```
