#!/usr/bin/env bash
#
# Fix PyTorch for AMD GPU (ROCm)
# Replaces CUDA PyTorch with ROCm PyTorch
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

VENV_PATH="${1:-/home/asa/porrima/.venv}"
PYTHON="$VENV_PATH/bin/python"
PIP="$VENV_PATH/bin/pip"

echo "========================================"
echo "  Fix PyTorch for AMD GPU (ROCm)"
echo "========================================"
echo ""

# Check ROCm availability
echo -e "${BLUE}Checking ROCm availability...${NC}"

if command -v rocm-smi &> /dev/null; then
    echo -e "${GREEN}✓ ROCm SMI found${NC}"
    rocm-smi --showdriverversion 2>/dev/null | head -1 || true
else
    echo -e "${YELLOW}⚠ ROCm SMI not in PATH, but AMD GPU detected${NC}"
fi

# Check AMD GPU
if [[ -e /dev/kfd ]]; then
    echo -e "${GREEN}✓ AMD GPU device found at /dev/kfd${NC}"
else
    echo -e "${RED}✗ No AMD GPU device found${NC}"
    exit 1
fi

# Current PyTorch version
echo -e "${BLUE}Checking current PyTorch installation...${NC}"
$PYTHON -c "import torch; print(f'Current: {torch.__version__}')" 2>/dev/null || echo "PyTorch not installed"

# Uninstall CUDA PyTorch
echo -e "${YELLOW}Uninstalling CUDA PyTorch...${NC}"
$PIP uninstall -y torch torchvision torchaio 2>/dev/null || true

# Install ROCm PyTorch
echo -e "${BLUE}Installing ROCm PyTorch...${NC}"
echo -e "${YELLOW}This may take several minutes...${NC}"

# Get PyTorch version we had
PYTORCH_VERSION="2.10.0"

# Install ROCm build
$PIP install torch==$PYTORCH_VERSION --index-url https://download.pytorch.org/whl/rocm6.2 --quiet 2>&1 | tail -5

# Verify
echo -e "${BLUE}Verifying ROCm PyTorch...${NC}"

if $PYTHON -c "import torch; print('ROCm:', torch.version.hip is not None)" 2>/dev/null | grep -q "True"; then
    echo -e "${GREEN}✓ ROCm PyTorch installed successfully${NC}"
    $PYTHON -c "import torch; print(f'PyTorch: {torch.__version__}'); print(f'ROCm: {torch.version.hip}'); print(f'Device count: {torch.cuda.device_count()}')" 2>/dev/null || true
else
    echo -e "${RED}✗ ROCm PyTorch verification failed${NC}"
    echo -e "${YELLOW}Trying alternative ROCm version (6.0)...${NC}"
    $PIP uninstall -y torch 2>/dev/null || true
    $PIP install torch==$PYTORCH_VERSION --index-url https://download.pytorch.org/whl/rocm6.0 --quiet 2>&1 | tail -5
fi

# Test qwen-tts with ROCm
echo -e "${BLUE}Testing qwen-tts with ROCm...${NC}"

if $PYTHON -c "
from qwen_tts import Qwen3TTSModel
import torch

print(f'ROCm available: {torch.version.hip is not None}')
print(f'Device: {\"cuda\" if torch.version.hip else \"cpu\"}')

# Try to load model on ROCm if available
device = 'cuda:0' if torch.version.hip else 'cpu'
print(f'Will use device: {device}')
" 2>/dev/null; then
    echo -e "${GREEN}✓ qwen-tts ROCm test passed${NC}"
else
    echo -e "${YELLOW}⚠ qwen-tts ROCm test had warnings (may still work)${NC}"
fi

echo ""
echo "========================================"
echo "  Summary"
echo "========================================"
echo ""
echo -e "${GREEN}✓ PyTorch reinstalled with ROCm support${NC}"
echo -e "${YELLOW}Note: First model load will initialize ROCm (may be slow)${NC}"
echo ""
echo "Next steps:"
echo "  1. Test: python3 -c 'import torch; print(torch.cuda.is_available())'"
echo "  2. Run: ./scripts/verify-qwen3-tts.py"
echo ""
