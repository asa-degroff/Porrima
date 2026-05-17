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
BACKEND=""
VENV_ROOT="${VENV_ROOT:-$ROOT_DIR/.venv-tts}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/server/.env.tts}"
PYTHON_BIN="${PYTHON_BIN:-}"

usage() {
  echo "Usage: $0 kokoro|qwen3-tts|supertonic-3|all [--python PATH] [--venv-root PATH] [--env-file PATH]"
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
    --python)
      PYTHON_BIN="$2"
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

python_version() {
  "$1" - <<'PY'
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}")
PY
}

python_supported_for_backend() {
  local python="$1"
  local backend="$2"
  "$python" - "$backend" <<'PY'
import sys

backend = sys.argv[1]
major, minor = sys.version_info[:2]
if major != 3:
    raise SystemExit(1)

if backend in {"kokoro", "qwen3-tts"}:
    raise SystemExit(0 if (10 <= minor < 14) else 1)

raise SystemExit(0 if (10 <= minor < 15) else 1)
PY
}

find_python_for_backend() {
  local backend="$1"
  local candidates=()

  if [[ -n "$PYTHON_BIN" ]]; then
    candidates+=("$PYTHON_BIN")
  fi

  candidates+=(python3.13 python3.12 python3.11 python3.10 python3 python)

  local candidate
  for candidate in "${candidates[@]}"; do
    if ! command -v "$candidate" >/dev/null 2>&1; then
      continue
    fi

    local resolved
    resolved="$(command -v "$candidate")"
    if python_supported_for_backend "$resolved" "$backend"; then
      printf '%s\n' "$resolved"
      return 0
    fi
  done

  return 1
}

explain_python_requirement() {
  local backend="$1"
  if [[ "$backend" == "kokoro" || "$backend" == "qwen3-tts" ]]; then
    echo "$backend requires Python 3.10-3.13 for reliable binary wheels. Python 3.14 commonly forces spaCy/torch dependencies to build from source."
  else
    echo "$backend requires Python 3.10-3.14."
  fi
  echo "Install a compatible Python and rerun with --python /path/to/python, or set PYTHON_BIN=/path/to/python."
  if command -v uv >/dev/null 2>&1; then
    echo "With uv installed, one option is:"
    echo "  uv python install 3.12"
    echo "  PYTHON_BIN=\"\$(uv python find 3.12)\" $0 $backend"
  fi
}

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
  local base_python
  if ! base_python="$(find_python_for_backend "$backend")"; then
    explain_python_requirement "$backend" >&2
    exit 1
  fi

  local base_version
  base_version="$(python_version "$base_python")"
  local python="$venv/bin/python"
  local pip="$venv/bin/pip"

  echo "Installing $backend into $venv using $base_python (Python $base_version)"
  "$base_python" -m venv "$venv"
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
