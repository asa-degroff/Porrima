# Onboarding Installation

Porrima onboarding has two layers:

1. Website-driven host setup.
2. In-app onboarding and tuning.

The required baseline is a Linux desktop with a capable NVIDIA CUDA or AMD ROCm GPU. CPU-only and typical laptop installs are not a recommended first-run target.

## Install Profiles

The default profile is `core`.

- `core`: Porrima, Node dependencies, SQLite/vector storage, llama.cpp, and managed llama.cpp user services.
- `tts`: optional Python TTS environment and audio tooling.
- `images`: optional image backend such as ComfyUI or stable-diffusion.cpp.
- `automations`: optional onboarding defaults for scheduled routines.

First-time users should start with `core`. Voice and image generation can be added later from Settings.

## Website Options

The website should offer:

- A copyable coding-agent prompt. This is the recommended path for early releases.
- A conservative one-line installer after the prompt-driven path is stable.

Generate a core-only prompt:

```bash
node install/render-agent-prompt.mjs --repo=https://github.com/YOUR_ORG/porrima.git --ref=main --features=core
```

Generate a full prompt:

```bash
node install/render-agent-prompt.mjs --repo=https://github.com/YOUR_ORG/porrima.git --ref=main --features=core,tts,images,automations
```

## Probe

`install/probe.sh` emits JSON for the website installer and future in-app onboarding flow:

```bash
bash install/probe.sh
```

It checks:

- OS and `systemd --user`
- Node/npm
- Python/pip
- CMake/Ninja
- ffmpeg
- NVIDIA CUDA or AMD ROCm tooling
- GPU count and VRAM where tools expose it
- `~/bin/llama-current/llama-server`

## Service Templates

The initial templates live in `install/templates/`.

The chat service is GPU-backed and router-mode oriented. Background services default to CPU-only so they do not contend with interactive chat inference unless later tuning proves spare VRAM exists.

Hardware-specific defaults live under `install/profiles/`.
