#!/usr/bin/env bash
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SERVER_DIR")"

set -a
[[ -f "$ROOT_DIR/.env" ]] && source "$ROOT_DIR/.env"
[[ -f "$SERVER_DIR/.env" ]] && source "$SERVER_DIR/.env"
[[ -f "$SERVER_DIR/.env.tts" ]] && source "$SERVER_DIR/.env.tts"
set +a

echo "Starting Porrima server with TTS backend-specific Python overrides where configured"
cd "$SERVER_DIR"
npm run dev
