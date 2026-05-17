#!/usr/bin/env bash
#
# Install an optional TTS backend into an isolated Python environment.
#
# Usage:
#   ./scripts/install-tts-backend.sh kokoro
#   ./scripts/install-tts-backend.sh qwen3-tts
#   ./scripts/install-tts-backend.sh supertonic-3
#   ./scripts/install-tts-backend.sh all
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="${1:-}"
VENV_ROOT="${VENV_ROOT:-$ROOT_DIR/.venv-tts}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/server/.env.tts}"

usage() {
  echo "Usage: $0 kokoro|qwen3-tts|supertonic-3|all [--venv-root PATH] [--env-file PATH]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    kokoro|qwen3-tts|supertonic-3|all)
      BACKEND="$1"
      shift
      ;;
    --venv-root)
      VENV_ROOT="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BACKEND" ]]; then
  usage >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

ensure_env_line() {
  local name="$1"
  local value="$2"
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"

  if grep -q "^${name}=" "$ENV_FILE"; then
    local escaped
    escaped="$(printf '%s\n' "$value" | sed 's/[&/\]/\\&/g')"
    sed -i "s/^${name}=.*/${name}=${escaped}/" "$ENV_FILE"
  else
    printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
  fi
}

install_backend() {
  local backend="$1"
  local venv="$VENV_ROOT/$backend"
  local python="$venv/bin/python"
  local pip="$venv/bin/pip"

  echo "Installing $backend into $venv"
  python3 -m venv "$venv"
  "$pip" install --upgrade pip

  case "$backend" in
    kokoro)
      "$pip" install numpy kokoro
      ensure_env_line "KOKORO_TTS_PYTHON_OVERRIDE" "$python"
      ;;
    qwen3-tts)
      "$pip" install qwen-tts torch soundfile
      ensure_env_line "QWEN3_TTS_PYTHON_OVERRIDE" "$python"
      ;;
    supertonic-3)
      "$pip" install supertonic soundfile numpy
      ensure_env_line "SUPERTONIC_TTS_PYTHON_OVERRIDE" "$python"
      ;;
  esac

  echo "Wrote interpreter override to $ENV_FILE"
  echo "Verify with: /api/tts/status?backend=$backend"
}

if [[ "$BACKEND" == "all" ]]; then
  install_backend kokoro
  install_backend qwen3-tts
  install_backend supertonic-3
else
  install_backend "$BACKEND"
fi

