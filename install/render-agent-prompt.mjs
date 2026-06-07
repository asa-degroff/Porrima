#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const repoUrl = argValue("repo", "https://github.com/asa-degroff/porrima.git");
const ref = argValue("ref", "main");
const featureArg = argValue("features", "core");
const features = new Set(featureArg.split(",").map((item) => item.trim()).filter(Boolean));
features.add("core");

const templatePath = path.join(root, "install", "templates", "agent-install-prompt.md");
let prompt = readFileSync(templatePath, "utf8");

const ttsInstructions = features.has("tts")
  ? [
      "Install the TTS pack.",
      "- Ask which TTS backend or backends to install if I have not specified them: `kokoro`, `qwen3-tts`, `supertonic-3`, or `all`.",
      "- Use `./scripts/install-tts-backend.sh <backend>` for each selected backend.",
      "- Let the installer create per-backend virtual environments under `.venv-tts/<backend>` and write interpreter overrides to `server/.env.tts`.",
      "- Use Python 3.10-3.13 for Kokoro and Qwen3-TTS so native wheels are available; pass `--python /path/to/python3.12` if needed.",
      "- Install or verify `ffmpeg`.",
      "- Validate each selected backend with `/api/tts/status?backend=<backend>` and a short synthesis test.",
    ].join("\n")
  : "Do not install TTS dependencies, voice models, or TTS services during initial setup.";

const imageInstructions = features.has("images")
  ? [
      "Install the image pack.",
      "- Ask before choosing ComfyUI or stable-diffusion.cpp if neither is already present.",
      "- Keep image dependencies isolated from the core app.",
      "- Configure GPU sharing so image generation does not starve chat inference.",
      "- Validate image backend health after setup.",
    ].join("\n")
  : "Do not install ComfyUI, stable-diffusion.cpp, image models, or image services during initial setup.";

prompt = prompt
  .replaceAll("{{REPO_URL}}", repoUrl)
  .replaceAll("{{REF}}", ref)
  .replaceAll("{{FEATURES}}", [...features].join(", "))
  .replaceAll("{{TTS_INSTRUCTIONS}}", ttsInstructions)
  .replaceAll("{{IMAGE_INSTRUCTIONS}}", imageInstructions);

process.stdout.write(prompt);
