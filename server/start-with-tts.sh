#!/bin/bash
# Start server with TTS Python environment
export TTS_PYTHON_OVERRIDE=/home/asa/quje-agent/.venv/bin/python
echo "Starting quje-agent server with TTS_PYTHON_OVERRIDE=$TTS_PYTHON_OVERRIDE"
cd /home/asa/quje-agent/server
npm run dev
