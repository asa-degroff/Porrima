#!/usr/bin/env bash
set -euo pipefail

json_escape() {
  local value
  value="$(cat)"
  value="${value//$'\\'/$'\\\\'}"
  value="${value//$'"'/$'\\"'}"
  value="${value//$'\n'/$'\\n'}"
  value="${value//$'\r'/}"
  printf '"%s"' "$value"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

cmd_version() {
  if has_cmd "$1"; then
    "$@" 2>&1 | head -n 1
  fi
}

bool_cmd() {
  if has_cmd "$1"; then printf true; else printf false; fi
}

detect_gpu_json() {
  if has_cmd nvidia-smi; then
    local rows
    rows="$(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>/dev/null || true)"
    if [ -n "$rows" ]; then
      if has_cmd python3; then
        python3 - "$rows" <<'PY'
import json, sys
rows = sys.argv[1].splitlines()
gpus = []
for row in rows:
    parts = [p.strip() for p in row.split(",")]
    if len(parts) >= 3:
        gpus.append({"name": parts[0], "vramMb": int(float(parts[1])), "driver": parts[2]})
print(json.dumps({"vendor": "nvidia", "backend": "cuda", "count": len(gpus), "gpus": gpus}))
PY
      else
        printf '{"vendor":"nvidia","backend":"cuda","count":1,"gpus":[]}'
      fi
      return
    fi
  fi

  if has_cmd rocm-smi; then
    local csv
    csv="$(rocm-smi --showproductname --showmeminfo vram --csv 2>/dev/null || true)"
    if has_cmd python3; then
      python3 - "$csv" <<'PY'
import csv, io, json, re, sys
text = sys.argv[1]
gpus = []
for row in csv.DictReader(io.StringIO(text)):
    name = next((v for k, v in row.items() if "Card series" in k or ("GPU" in k and "Card" in k)), "").strip()
    vram = 0
    for k, v in row.items():
        if "VRAM Total Memory" in k:
            nums = re.findall(r"\d+", v or "")
            if nums:
                raw = int(nums[0])
                vram = raw // (1024 * 1024) if raw > 1024 * 1024 else raw
    if name or vram:
        gpus.append({"name": name or "AMD GPU", "vramMb": vram})
print(json.dumps({"vendor": "amd", "backend": "rocm", "count": len(gpus), "gpus": gpus}))
PY
    else
      printf '{"vendor":"amd","backend":"rocm","count":1,"gpus":[]}'
    fi
    return
  fi

  printf '{"vendor":"unknown","backend":"unknown","count":0,"gpus":[]}'
}

os_release="$(cat /etc/os-release 2>/dev/null || true)"
systemd_user=false
if systemctl --user show-environment >/dev/null 2>&1; then
  systemd_user=true
fi

cat <<JSON
{
  "schemaVersion": 1,
  "platform": {
    "kernel": $(uname -srmo | json_escape),
    "osRelease": $(printf "%s" "$os_release" | json_escape),
    "systemdUser": $systemd_user
  },
  "tools": {
    "git": { "present": $(bool_cmd git), "version": $(cmd_version git --version | json_escape) },
    "node": { "present": $(bool_cmd node), "version": $(cmd_version node --version | json_escape) },
    "npm": { "present": $(bool_cmd npm), "version": $(cmd_version npm --version | json_escape) },
    "python3": { "present": $(bool_cmd python3), "version": $(cmd_version python3 --version | json_escape) },
    "pip3": { "present": $(bool_cmd pip3), "version": $(cmd_version pip3 --version | json_escape) },
    "cmake": { "present": $(bool_cmd cmake), "version": $(cmd_version cmake --version | json_escape) },
    "ninja": { "present": $(bool_cmd ninja), "version": $(cmd_version ninja --version | json_escape) },
    "ffmpeg": { "present": $(bool_cmd ffmpeg), "version": $(cmd_version ffmpeg -version | json_escape) },
    "nvidiaSmi": { "present": $(bool_cmd nvidia-smi), "version": $(cmd_version nvidia-smi --version | json_escape) },
    "rocmSmi": { "present": $(bool_cmd rocm-smi), "version": $(cmd_version rocm-smi --version | json_escape) },
    "hipcc": { "present": $(bool_cmd hipcc), "version": $(cmd_version hipcc --version | json_escape) },
    "nvcc": { "present": $(bool_cmd nvcc), "version": $(cmd_version nvcc --version | json_escape) }
  },
  "hardware": {
    "memory": $(free -h 2>/dev/null | json_escape),
    "gpu": $(detect_gpu_json)
  },
  "llamaCpp": {
    "defaultBinary": "$HOME/bin/llama-current/llama-server",
    "defaultBinaryPresent": $([ -x "$HOME/bin/llama-current/llama-server" ] && printf true || printf false),
    "version": $("$HOME/bin/llama-current/llama-server" --version 2>/dev/null | head -n 1 | json_escape)
  }
}
JSON
