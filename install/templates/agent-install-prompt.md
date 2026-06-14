You are installing Porrima on my Linux desktop.

First probe the machine and summarize a plan before installing anything. Do not overwrite existing services or model directories without making backups and explaining the change.

Project:
- Repository: {{REPO_URL}}
- Branch/ref: {{REF}}
- Install profile: {{FEATURES}}

Before installing:
- Probe the machine, then summarize what you found and the exact install plan.
- Ask me for any missing choices before making changes:
  - install directory
  - public Porrima hostname, if remote access should be configured
  - Cloudflare account/zone and whether Cloudflare Access is available
  - model choices or model download preferences
  - whether optional TTS, image generation, and automations should be installed now
- Do not overwrite existing services, data directories, model directories, or Cloudflare tunnel config without making backups and explaining the change.

Requirements:
- This is a desktop-GPU application. If no capable NVIDIA CUDA or AMD ROCm GPU is available, stop and report that the machine does not meet the recommended requirements.
- Prefer reversible user-local installation.
- Use systemd user services, not root services, unless OS package installation is required.
- Install the core llama.cpp-based agent first. TTS and image generation are optional packs; only install the packs listed in the install profile.
- Do not expose first-run Porrima on a public URL unless the raw first-run setup token has been printed to the `porrima.service` journal, the hash state exists at `~/.porrima/auth/setup-token.txt`, and `ORIGIN`/`RP_ID` are configured for that public origin.

Probe:
Run and summarize:

```bash
uname -a
cat /etc/os-release
node --version || true
npm --version || true
python3 --version || true
pip3 --version || true
systemctl --user show-environment || true
lspci | grep -Ei 'vga|3d|display' || true
nvidia-smi || true
rocm-smi || true
hipcc --version || true
nvcc --version || true
cmake --version || true
ninja --version || true
ffmpeg -version || true
free -h
df -h
```

Core install tasks:
- Install or verify Node.js and npm.
- Install native build prerequisites for Node modules such as better-sqlite3, sharp, and sqlite-vec.
- Build or install llama.cpp with the best supported backend for this machine.
- Create `~/bin/llama-current/llama-server`.
- Create `~/.local/share/llama-models` for GGUF models.
- Download, import, or symlink GGUF models into the curated layout:
  - `~/.local/share/llama-models/<chat-model-id>/<model>.gguf`
  - `~/.local/share/llama-models/<extraction-model-id>/<model>.gguf`
  - `~/.local/share/llama-models/<reranker-model-id>/<model>.gguf`
  - `~/.local/share/llama-models/<embedding-model-id>/<model>.gguf`
  - optional projector files such as `mmproj*.gguf` should live beside the primary model.
- Do not leave models only in the raw Hugging Face cache; Porrima scans the curated top-level model directories above.
- Choose stable model aliases that match the directory names and the aliases used in service files/settings.
- Create user systemd services for:
  - `porrima.service`
  - `llama-server.service` on port 32100
  - `extraction-model.service` on port 32101
  - `reranker.service` on port 32102
  - `embedding-model.service` on port 32103
  - `title-generation.service` on port 32104
- Configure each llama.cpp service with the selected model alias:
  - chat inference: router mode with `--models-dir ~/.local/share/llama-models`
  - extraction: chat-completion model, CPU-only by default
  - reranker: `--embedding --reranking --pooling rank`
  - embedding: `--embedding --pooling mean`
  - title generation: chat-completion model, CPU-only by default
- Use CPU-only defaults for extraction, reranker, embedding, and title generation unless spare VRAM is explicitly available.
- In production, build both workspaces and run the Node server with `NODE_ENV=production` on the configured app port. The production server serves `client/dist` itself.
- Configure `porrima.service` itself, or a systemd drop-in under `~/.config/systemd/user/porrima.service.d/`, with explicit WebAuthn environment values before the first production start:
  - local-only setup: `Environment=ORIGIN=http://localhost:<port>` and `Environment=RP_ID=localhost`
  - remote setup: `Environment=ORIGIN=https://<public-hostname>` and `Environment=RP_ID=<public-hostname without port>`
  - the `ORIGIN` value must be the exact browser origin used for passkey registration; the `RP_ID` must match that origin's hostname.
- Do not set `PORRIMA_DEV_TOKEN` in production; Porrima refuses to start with the development bearer-token bypass variable set under `NODE_ENV=production`.
- For dual equal GPUs, use tensor split for chat inference.
- Preserve performance flags such as flash attention, tensor split, batch/ubatch sizing, visible GPU environment variables, and llama.cpp library paths.

Passkey and Cloudflare setup:
- If I want remote access, ask for the final HTTPS hostname before passkey registration. WebAuthn passkeys are origin/RP-bound, so a passkey registered only on `localhost` will not be usable on the Cloudflare hostname.
- Production startup requires explicit WebAuthn settings in the `porrima.service` environment, not just shell-local exports:
  - `ORIGIN=https://<public-hostname>`
  - `RP_ID=<public-hostname without port>`
- If using a Cloudflare Tunnel such as `https://porrima.example.com -> http://localhost:3001`, keep `PORT=3001`, set `ORIGIN=https://porrima.example.com`, and set `RP_ID=porrima.example.com`. Do not set `ORIGIN` to the localhost target for a public passkey registration flow.
- Preferred safe sequence:
  1. Build and start Porrima locally, bound only to localhost.
  2. Read the raw first-run setup token from `journalctl --user -u porrima.service`; confirm `~/.porrima/auth/setup-token.txt` exists but contains `tokenSha256` metadata, not the plaintext token.
  3. Create the Cloudflare Tunnel and DNS route. Use Cloudflare Access or an equivalent temporary access policy when available as an extra guard.
  4. Visit the final HTTPS hostname and register the first owner passkey in Porrima using the raw setup token from the journal.
  5. Confirm `GET /api/auth/status` reports `setupComplete: true` and the setup-token state file has been removed.
  6. Only then remove the temporary Cloudflare Access policy if I want the Porrima passkey gate to be the only public gate.
- Do not paste the hash from `setup-token.txt` into the browser; it is only there so the server can verify the raw token. Setup tokens expire after 30 minutes, lock after 10 failed attempts, and are removed after the first successful owner passkey registration. Restart the setup run to generate a fresh token if the current one expires or locks.
- Do not bypass the setup-token gate or expose a first-run Porrima instance whose raw setup token is missing, expired, locked, or unreadable from the journal.
- If I choose local-only setup, register the first passkey from `localhost` and leave Cloudflare Tunnel disabled.
- Install or verify `cloudflared` only if remote access is requested.
- For a Cloudflare-managed service, create a user-local tunnel config and systemd user service, keep the tunnel target pointed at the production Porrima server on localhost, and include commands to inspect tunnel health and logs.

Optional TTS pack:
{{TTS_INSTRUCTIONS}}

Optional image pack:
{{IMAGE_INSTRUCTIONS}}

Validation:
- Run `systemctl --user daemon-reload`.
- Enable and start selected services.
- Check `systemctl --user status` for every service.
- Confirm `systemctl --user show porrima.service -p Environment -p ExecStart -p WorkingDirectory` shows `NODE_ENV=production`, the intended `PORT`, and matching `ORIGIN`/`RP_ID`; missing WebAuthn values will make Porrima exit during startup and can surface as proxy 502 errors.
- Check every llama.cpp service `/health` and `/v1/models`:
  - `http://localhost:32100` chat inference
  - `http://localhost:32101` extraction
  - `http://localhost:32102` reranker
  - `http://localhost:32103` embedding
  - `http://localhost:32104` title generation
- For the chat router, load the selected chat model if needed and run a short `/v1/chat/completions` request.
- For extraction and title generation, run short `/v1/chat/completions` requests using their configured aliases.
- For the reranker, run a small `/v1/rerank` request.
- For the embedding server, run a small `/v1/embeddings` request.
- Confirm Porrima sees the same models through `/api/llama-servers`, `/api/llama-servers/available-models?slot=inference`, `/api/llama-servers/available-models?slot=embedding`, `/api/llama-servers/available-models?slot=reranker`, `/api/llama-servers/available-models?slot=extraction`, and `/api/llama-servers/available-models?slot=title-generation`.
- Check Porrima `/api/auth/status` locally and, if remote access was configured, through the final HTTPS hostname.
- Load a small test model if needed and run a short prompt benchmark.
- Report selected model aliases, tokens/sec, selected backend, GPU visibility, VRAM use, passkey setup state, tunnel/access state, and any warnings.
