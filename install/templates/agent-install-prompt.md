You are installing Porrima on my Linux desktop.

First probe the machine and summarize a plan before installing anything. Do not overwrite existing services or model directories without making backups and explaining the change.

Project:
- Repository: {{REPO_URL}}
- Branch/ref: {{REF}}
- Install profile: {{FEATURES}}

Requirements:
- This is a desktop-GPU application. If no capable NVIDIA CUDA or AMD ROCm GPU is available, stop and report that the machine does not meet the recommended requirements.
- Prefer reversible user-local installation.
- Use systemd user services, not root services, unless OS package installation is required.
- Install the core llama.cpp-based agent first. TTS and image generation are optional packs; only install the packs listed in the install profile.

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
  - `llama-server.service` on port 8080
  - `extraction-model.service` on port 8083
  - `reranker.service` on port 8082
  - `title-generation.service` on port 8085
- Use CPU-only defaults for extraction, reranker, embedding, and title generation unless spare VRAM is explicitly available.
- For dual equal GPUs, use tensor split for chat inference.
- Preserve performance flags such as flash attention, tensor split, batch/ubatch sizing, visible GPU environment variables, and llama.cpp library paths.

Optional TTS pack:
{{TTS_INSTRUCTIONS}}

Optional image pack:
{{IMAGE_INSTRUCTIONS}}

Validation:
- Run `systemctl --user daemon-reload`.
- Enable and start selected services.
- Check `systemctl --user status` for every service.
- Check llama.cpp `/health` and `/v1/models`.
- Load a small test model if needed and run a short prompt benchmark.
- Report tokens/sec, selected backend, GPU visibility, VRAM use, and any warnings.
