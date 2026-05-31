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
- Do not expose Porrima on an unprotected public URL until an owner passkey exists for that public origin.

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
- Create user systemd services for:
  - `porrima.service`
  - `llama-server.service` on port 32100
  - `extraction-model.service` on port 32101
  - `reranker.service` on port 32102
  - `embedding-model.service` on port 32103
  - `title-generation.service` on port 32104
- Use CPU-only defaults for extraction, reranker, embedding, and title generation unless spare VRAM is explicitly available.
- In production, build both workspaces and run the Node server with `NODE_ENV=production` on the configured app port. The production server serves `client/dist` itself.
- For dual equal GPUs, use tensor split for chat inference.
- Preserve performance flags such as flash attention, tensor split, batch/ubatch sizing, visible GPU environment variables, and llama.cpp library paths.

Passkey and Cloudflare setup:
- If I want remote access, ask for the final HTTPS hostname before passkey registration. WebAuthn passkeys are origin/RP-bound, so a passkey registered only on `localhost` will not be usable on the Cloudflare hostname.
- Configure Porrima with:
  - `ORIGIN=https://<public-hostname>`
  - `RP_ID=<public-hostname without port>`
- Preferred safe sequence:
  1. Build and start Porrima locally, bound only to localhost.
  2. Create the Cloudflare Tunnel and DNS route only behind Cloudflare Access or an equivalent temporary access policy.
  3. Visit the final HTTPS hostname through that temporary protection and register the first owner passkey in Porrima.
  4. Confirm `GET /api/auth/status` reports `setupComplete: true`.
  5. Only then remove the temporary Cloudflare Access policy if I want the Porrima passkey gate to be the only public gate.
- If Cloudflare Access or an equivalent temporary protection is not available, stop before opening the public route and explain the security risk. Do not create an unprotected public tunnel to a first-run Porrima instance.
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
- Check llama.cpp `/health` and `/v1/models`.
- Check the embedding server `/health` and a small `/v1/embeddings` request.
- Check Porrima `/api/auth/status` locally and, if remote access was configured, through the final HTTPS hostname.
- Load a small test model if needed and run a short prompt benchmark.
- Report tokens/sec, selected backend, GPU visibility, VRAM use, passkey setup state, tunnel/access state, and any warnings.
