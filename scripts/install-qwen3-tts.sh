#!/usr/bin/env bash
#
# Qwen3-TTS Installation Script for Porrima
# 
# This script installs the qwen-tts Python package, downloads model weights,
# and verifies the installation.
#
# Usage: ./scripts/install-qwen3-tts.sh [--venv-path PATH]
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
VENV_PATH="${VENV_PATH:-.venv}"
MODEL_NAME="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --venv-path)
            VENV_PATH="$2"
            shift 2
            ;;
        --model)
            MODEL_NAME="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [--venv-path PATH] [--model MODEL]"
            echo ""
            echo "Options:"
            echo "  --venv-path PATH   Path to Python venv (default: .venv)"
            echo "  --model MODEL      HuggingFace model ID (default: Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice)"
            echo "  --help             Show this help message"
            exit 0
            ;;
        *)
            echo "${RED}Unknown option: $1${NC}" >&2
            exit 1
            ;;
    esac
done

echo "========================================"
echo "  Qwen3-TTS Installation for Porrima"
echo "========================================"
echo ""

# Check Python availability
check_python() {
    echo -e "${BLUE}Checking Python availability...${NC}"
    
    if command -v python3 &> /dev/null; then
        PYTHON_CMD="python3"
    elif command -v python &> /dev/null; then
        PYTHON_CMD="python"
    else
        echo -e "${RED}Error: Python not found in PATH${NC}"
        exit 1
    fi
    
    PYTHON_VERSION=$($PYTHON_CMD --version 2>&1 | cut -d' ' -f2)
    echo -e "${GREEN}✓ Found Python: $PYTHON_CMD ($PYTHON_VERSION)${NC}"
    
    # Check minimum version (3.10+)
    if [[ "$PYTHON_VERSION" < "3.10" ]]; then
        echo -e "${RED}Error: Python 3.10+ required (found $PYTHON_VERSION)${NC}"
        exit 1
    fi
}

# Check/activate virtual environment
check_venv() {
    echo -e "${BLUE}Checking virtual environment...${NC}"
    
    if [[ -d "$VENV_PATH" ]]; then
        echo -e "${GREEN}✓ Found venv at: $VENV_PATH${NC}"
        PYTHON_CMD="$VENV_PATH/bin/python"
        PIP_CMD="$VENV_PATH/bin/pip"
    else
        echo -e "${YELLOW}Venv not found at $VENV_PATH${NC}"
        echo -e "${YELLOW}Checking for system Python...${NC}"
        
        if command -v pip3 &> /dev/null; then
            PIP_CMD="pip3"
        elif command -v pip &> /dev/null; then
            PIP_CMD="pip"
        else
            echo -e "${RED}Error: pip not found${NC}"
            exit 1
        fi
        
        echo -e "${YELLOW}Will install to system Python (not recommended for production)${NC}"
    fi
    
    echo -e "${GREEN}✓ Using Python: $PYTHON_CMD${NC}"
    echo -e "${GREEN}✓ Using pip: $PIP_CMD${NC}"
}

# Install Python packages
install_packages() {
    echo -e "${BLUE}Installing Python packages...${NC}"
    echo ""
    
    # Upgrade pip first
    echo -e "${YELLOW}Upgrading pip...${NC}"
    $PIP_CMD install --upgrade pip --quiet
    
    # Install core packages
    echo -e "${YELLOW}Installing qwen-tts, torch, soundfile...${NC}"
    $PIP_CMD install qwen-tts torch soundfile --quiet
    
    # Check if CUDA is available (optional FlashAttention)
    if $PYTHON_CMD -c "import torch; print(torch.cuda.is_available())" 2>/dev/null | grep -q "True"; then
        echo -e "${GREEN}✓ CUDA detected${NC}"
        echo -e "${YELLOW}Installing FlashAttention for performance...${NC}"
        if $PIP_CMD install flash-attn --no-build-isolation --quiet 2>/dev/null; then
            echo -e "${GREEN}✓ FlashAttention installed${NC}"
        else
            echo -e "${YELLOW}⚠ FlashAttention installation failed (continuing without it)${NC}"
        fi
    else
        echo -e "${YELLOW}CUDA not detected, skipping FlashAttention${NC}"
    fi
    
    echo -e "${GREEN}✓ Core packages installed${NC}"
}

# Verify package installation
verify_packages() {
    echo -e "${BLUE}Verifying package installation...${NC}"
    
    if $PYTHON_CMD -c "import qwen_tts" 2>/dev/null; then
        echo -e "${GREEN}✓ qwen_tts imported successfully${NC}"
    else
        echo -e "${RED}✗ Failed to import qwen_tts${NC}"
        return 1
    fi
    
    if $PYTHON_CMD -c "import torch" 2>/dev/null; then
        echo -e "${GREEN}✓ torch imported successfully${NC}"
    else
        echo -e "${RED}✗ Failed to import torch${NC}"
        return 1
    fi
    
    if $PYTHON_CMD -c "import soundfile" 2>/dev/null; then
        echo -e "${GREEN}✓ soundfile imported successfully${NC}"
    else
        echo -e "${RED}✗ Failed to import soundfile${NC}"
        return 1
    fi
    
    return 0
}

# Download model weights
download_model() {
    echo -e "${BLUE}Downloading model weights: $MODEL_NAME${NC}"
    echo -e "${YELLOW}This may take several minutes (~2GB download)${NC}"
    echo ""
    
    # Pre-download model to cache
    $PYTHON_CMD << EOF
from qwen_tts import Qwen3TTSModel
import sys

print("Loading model (this will download weights if not cached)...")
try:
    model = Qwen3TTSModel.from_pretrained("$MODEL_NAME")
    print("Model loaded successfully!")
    print(f"Model device: {model.device}")
    print(f"Model dtype: {model.dtype}")
except Exception as e:
    print(f"Error loading model: {e}", file=sys.stderr)
    sys.exit(1)
EOF
    
    if [[ $? -eq 0 ]]; then
        echo -e "${GREEN}✓ Model downloaded and cached${NC}"
    else
        echo -e "${RED}✗ Model download failed${NC}"
        return 1
    fi
}

# Test generation
test_generation() {
    echo -e "${BLUE}Testing TTS generation...${NC}"
    echo ""
    
    $PYTHON_CMD << EOF
import sys
import io
from qwen_tts import Qwen3TTSModel
import torch
import soundfile as sf

# Load model
model = Qwen3TTSModel.from_pretrained("$MODEL_NAME")

# Test generation
test_text = "Hello from Qwen3-TTS! This is a test."
print(f"Generating: '{test_text}'")

try:
    wavs, sr = model.generate_custom_voice(
        text=test_text,
        language="English",
        speaker="Ryan",
    )
    
    if wavs is None or len(wavs) == 0:
        print("Error: No audio generated", file=sys.stderr)
        sys.exit(1)
    
    duration = len(wavs[0]) / sr
    print(f"✓ Generated {duration:.2f}s of audio")
    print(f"✓ Sample rate: {sr} Hz")
    print(f"✓ Audio shape: {wavs[0].shape}")
    
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
EOF
    
    if [[ $? -eq 0 ]]; then
        echo -e "${GREEN}✓ TTS generation test passed${NC}"
    else
        echo -e "${RED}✗ TTS generation test failed${NC}"
        return 1
    fi
}

# Print summary
print_summary() {
    echo ""
    echo "========================================"
    echo "  Installation Complete!"
    echo "========================================"
    echo ""
    echo -e "${GREEN}✓ qwen-tts package installed${NC}"
    echo -e "${GREEN}✓ Model weights downloaded: $MODEL_NAME${NC}"
    echo -e "${GREEN}✓ TTS generation verified${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Restart the Porrima server"
    echo "  2. Test the API: curl http://localhost:3001/api/tts/status?backend=qwen3-tts"
    echo "  3. Generate audio: curl -X POST http://localhost:3001/api/tts/generate -H 'Content-Type: application/json' -d '{\"text\":\"Hello\",\"voice\":\"Ryan\"}'"
    echo ""
    echo -e "${YELLOW}Note: First generation may be slow as model initializes. Subsequent calls will be faster.${NC}"
    echo ""
}

# Main execution
main() {
    check_python
    check_venv
    
    echo ""
    read -p "Proceed with installation? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Installation cancelled${NC}"
        exit 0
    fi
    
    echo ""
    install_packages
    
    if ! verify_packages; then
        echo -e "${RED}Package verification failed${NC}"
        exit 1
    fi
    
    echo ""
    read -p "Download model weights (~2GB)? [y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if ! download_model; then
            echo -e "${YELLOW}Model download failed, but packages are installed${NC}"
            echo -e "${YELLOW}Model will download on first use${NC}"
        fi
        
        echo ""
        read -p "Run generation test? [y/N] " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            test_generation
        fi
    else
        echo -e "${YELLOW}Skipping model download (will download on first use)${NC}"
    fi
    
    print_summary
}

main "$@"
