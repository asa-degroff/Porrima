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
      "- Create an isolated Python virtual environment under `~/.local/share/porrima/venvs/tts`.",
      "- Install backend-specific Python dependencies there, not into system Python.",
      "- Install or verify `ffmpeg`.",
      "- Validate the selected TTS backend with a short synthesis test.",
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
