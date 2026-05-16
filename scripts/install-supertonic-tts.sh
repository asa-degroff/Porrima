#!/usr/bin/env bash
#
# Supertonic 3 TTS Installation Script for quje-agent
#
# Installs the Supertonic Python package and verifies a local generation path.
#
# Usage: ./scripts/install-supertonic-tts.sh [--venv-path PATH]
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

VENV_PATH="${VENV_PATH:-.venv}"
VOICE="M1"

while [[ $# -gt 0 ]]; do
    case $1 in
        --venv-path)
            VENV_PATH="$2"
            shift 2
            ;;
        --voice)
            VOICE="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [--venv-path PATH] [--voice VOICE]"
            echo ""
            echo "Options:"
            echo "  --venv-path PATH   Path to Python venv (default: .venv)"
            echo "  --voice VOICE      Supertonic voice style to test (default: M1)"
            echo "  --help             Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}" >&2
            exit 1
            ;;
    esac
done

echo "============================================="
echo "  Supertonic 3 TTS Installation for quje-agent"
echo "============================================="
echo ""

if [[ -d "$VENV_PATH" ]]; then
    PYTHON_CMD="$VENV_PATH/bin/python"
    PIP_CMD="$VENV_PATH/bin/pip"
else
    echo -e "${YELLOW}Venv not found at $VENV_PATH${NC}"
    if command -v python3 &> /dev/null; then
        PYTHON_CMD="python3"
    elif command -v python &> /dev/null; then
        PYTHON_CMD="python"
    else
        echo -e "${RED}Error: Python not found in PATH${NC}"
        exit 1
    fi

    if command -v pip3 &> /dev/null; then
        PIP_CMD="pip3"
    elif command -v pip &> /dev/null; then
        PIP_CMD="pip"
    else
        echo -e "${RED}Error: pip not found in PATH${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}Using Python: $PYTHON_CMD${NC}"
echo -e "${GREEN}Using pip: $PIP_CMD${NC}"
echo ""

echo -e "${BLUE}Installing Supertonic...${NC}"
$PIP_CMD install --upgrade pip --quiet
$PIP_CMD install supertonic --quiet
echo -e "${GREEN}Supertonic package installed${NC}"
echo ""

echo -e "${BLUE}Verifying installation and downloading model assets if needed...${NC}"
$PYTHON_CMD scripts/verify-supertonic-tts.py --voice "$VOICE"

echo ""
echo -e "${GREEN}Supertonic 3 is ready to use.${NC}"
