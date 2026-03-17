# Qwen3-TTS Setup Instructions

## Problem
The Qwen3-TTS wrapper requires Python packages (`soundfile`, `qwen_tts`, etc.) installed in the virtual environment, but the server wasn't using the venv Python.

## Solution

### Option 1: Start server with environment variable (Recommended)

```bash
cd /home/asa/quje-agent/server
export TTS_PYTHON_OVERRIDE=/home/asa/quje-agent/.venv/bin/python
npm run dev
```

Or use the provided script:
```bash
./server/start-with-tts.sh
```

### Option 2: Set environment variable permanently

Add to your `~/.bashrc` or `~/.zshrc`:
```bash
export TTS_PYTHON_OVERRIDE=/home/asa/quje-agent/.venv/bin/python
```

Then restart your terminal and start the server normally.

### Option 3: Install packages system-wide (Not recommended)

```bash
sudo pip3 install soundfile qwen-tts torch
```

## Verification

After starting the server with the correct Python, test TTS:

1. Open browser DevTools Console
2. Run: `fetch('/api/tts/status?backend=qwen3-tts').then(r=>r.json()).then(console.log)`
3. Should show: `{backend: "qwen3-tts", available: true, ...}`

## Troubleshooting

If you still see "ModuleNotFoundError: No module named 'soundfile'":

1. Verify venv Python has soundfile:
   ```bash
   /home/asa/quje-agent/.venv/bin/python -c "import soundfile; print(soundfile.__version__)"
   ```

2. Check server is using correct Python:
   ```bash
   echo $TTS_PYTHON_OVERRIDE
   # Should show: /home/asa/quje-agent/.venv/bin/python
   ```

3. Restart server after setting the environment variable.
