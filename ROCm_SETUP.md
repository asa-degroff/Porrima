# AMD GPU (ROCm) Setup for Qwen3-TTS

## Issue

Your system has **AMD GPUs** but PyTorch was installed with **CUDA** support. This causes:
- `torch.cuda.is_available()` returns `False`
- Model runs on CPU instead of GPU
- Much slower inference

## Solution

Reinstall PyTorch with ROCm (AMD GPU) support:

```bash
cd /home/asa/quje-agent
./scripts/fix-pytorch-rocm.sh
```

This script:
1. Detects AMD GPU via `/dev/kfd` and `rocm-smi`
2. Uninstalls CUDA PyTorch
3. Installs ROCm PyTorch from PyTorch ROCm repository
4. Verifies ROCm detection
5. Tests qwen-tts with ROCm

## Manual Installation

If the script doesn't work:

```bash
# Activate venv
source .venv/bin/activate

# Uninstall CUDA PyTorch
pip uninstall -y torch torchvision torchaio

# Install ROCm PyTorch (adjust version based on your ROCm installation)
pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/rocm6.2

# Verify
python3 -c "import torch; print('ROCm:', torch.version.hip is not None)"
```

## ROCm Versions

Match PyTorch ROCm version to your system ROCm:

| System ROCm | PyTorch Index URL |
|-------------|-------------------|
| 6.2 | `https://download.pytorch.org/whl/rocm6.2` |
| 6.1 | `https://download.pytorch.org/whl/rocm6.1` |
| 6.0 | `https://download.pytorch.org/whl/rocm6.0` |
| 5.7 | `https://download.pytorch.org/whl/rocm5.7` |

Check your ROCm version:

```bash
rocm-smi --showdriverversion
# or
cat /etc/issue.net  # Some distros show ROCm version
```

## Flash-Attention for ROCm

Flash-attention has **experimental ROCm support**. After installing ROCm PyTorch:

```bash
# Try installing flash-attn with ROCm
pip install flash-attn --no-build-isolation

# If that fails, try from source
pip install flash-attn --no-build-isolation --force-reinstall
```

Note: ROCm flash-attention is less mature than CUDA version. If it fails, standard attention will work (just slower).

## Verify GPU Usage

After ROCm installation:

```bash
# Check ROCm detection
python3 -c "import torch; print('ROCm:', torch.version.hip is not None)"

# Verify qwen-tts uses GPU
python3 scripts/verify-qwen3-tts.py

# Monitor GPU during generation
rocm-smi --showactivity
```

## Performance Comparison

| Configuration | Expected Speed |
|---------------|----------------|
| CPU only | ~0.3x real-time |
| ROCm GPU | ~2-5x real-time |
| ROCm + flash-attn | ~3-8x real-time |

## Troubleshooting

### HIP kernel error

```
RuntimeError: HIP kernel error
```

Solution: Ensure ROCm drivers are installed:

```bash
sudo apt install rocm-dev rocm-utils
```

### Device not visible

```
No GPU devices found
```

Check permissions:

```bash
ls -l /dev/kfd /dev/dri
# Should be readable by your user
sudo usermod -aG render $USER  # Add to render group
```

### Wrong ROCm version

If PyTorch doesn't detect ROCm, try different version:

```bash
pip uninstall -y torch
pip install torch --index-url https://download.pytorch.org/whl/rocm6.0
```

## Resources

- [PyTorch ROCm](https://pytorch.org/get-started/locally/)
- [ROCm Documentation](https://rocm.docs.amd.com/)
- [Flash-Attention ROCm](https://github.com/Dao-AILab/flash-attention)
