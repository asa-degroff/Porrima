#!/usr/bin/env python3
"""
Qwen3-TTS wrapper for Porrima.
Generates WAV audio from text and outputs to stdout.

Usage:
    python qwen3_wrapper.py --text "Hello world" --speaker Ryan --speed 1.0

Environment:
    QWEN_TTS_ATTN: Attention backend (sdpa, eager, flash_attention_2). Default: sdpa for ROCm.

Output:
    Binary WAV data to stdout
    Metadata JSON to stderr
"""

import argparse
import json
import os
import sys
import io

# Redirect stdout during imports to prevent library warnings from corrupting
# the binary WAV output (e.g. "flash-attn is not installed" prints to stdout)
_real_stdout = sys.stdout
sys.stdout = sys.stderr

import torch
import soundfile as sf
from qwen_tts import Qwen3TTSModel

# Restore stdout for WAV output
sys.stdout = _real_stdout


def main():
    parser = argparse.ArgumentParser(description="Generate TTS audio using Qwen3-TTS")
    parser.add_argument("--text", required=True, help="Text to synthesize")
    parser.add_argument("--speaker", default="Ryan", help="Speaker ID (default: Ryan)")
    parser.add_argument("--speed", type=float, default=1.0, help="Speed multiplier (default: 1.0)")
    parser.add_argument("--language", default="English", help="Language (default: English)")
    parser.add_argument("--instruct", default="", help="Instruction for tone/emotion (optional)")
    parser.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", help="Model path or HF ID")
    args = parser.parse_args()

    try:
        # Load model on startup (cached for subsequent calls in same process)
        model = getattr(main, '_model', None)
        if model is None:
            print(f"[Qwen3-TTS] Loading model: {args.model}", file=sys.stderr)

            # Detect device
            if torch.cuda.is_available():
                device_map = "cuda:0"
                gpu_name = torch.cuda.get_device_name(0)
                print(f"[Qwen3-TTS] Using GPU: {gpu_name}", file=sys.stderr)

                # bfloat16 works on both ROCm and CUDA (float16 broken on ROCm RDNA3)
                dtype = torch.bfloat16
                print(f"[Qwen3-TTS] Using bfloat16", file=sys.stderr)
            else:
                device_map = "cpu"
                dtype = torch.float32
                print("[Qwen3-TTS] Using CPU", file=sys.stderr)

            # Attention: sdpa for GPU, eager for CPU
            attn_env = os.environ.get("QWEN_TTS_ATTN", "").lower()
            if attn_env == "flash_attention_2":
                attn_impl = "flash_attention_2"
            elif attn_env == "sdpa" or (attn_env == "" and torch.cuda.is_available()):
                attn_impl = "sdpa"
                if torch.version.hip:
                    os.environ["TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL"] = "1"
                    # FAST mode avoids exhaustive MIOpen kernel search (huge perf difference)
                    os.environ.setdefault("MIOPEN_FIND_MODE", "FAST")
            else:
                attn_impl = "eager"

            print(f"[Qwen3-TTS] Using {attn_impl} attention", file=sys.stderr)

            # Redirect stdout during model loading to prevent library warnings
            # from corrupting binary WAV output
            sys.stdout = sys.stderr
            model = Qwen3TTSModel.from_pretrained(
                args.model,
                device_map=device_map,
                dtype=dtype,
                attn_implementation=attn_impl,
            )
            sys.stdout = _real_stdout

            main._model = model
            print(f"[Qwen3-TTS] Model loaded on {device_map} with dtype {dtype}", file=sys.stderr)
        
        # Generate audio (redirect stdout in case library prints during inference)
        sys.stdout = sys.stderr
        wavs, sr = model.generate_custom_voice(
            text=args.text,
            language=args.language,
            speaker=args.speaker,
            instruct=args.instruct if args.instruct else None,
        )
        sys.stdout = _real_stdout
        
        if wavs is None or len(wavs) == 0:
            raise ValueError("No audio generated")
        
        # Write WAV to stdout
        wav_buffer = io.BytesIO()
        sf.write(wav_buffer, wavs[0], sr, format='WAV')
        sys.stdout.buffer.write(wav_buffer.getvalue())
        sys.stdout.buffer.flush()
        
        # Metadata to stderr
        duration = len(wavs[0]) / sr
        metadata = {
            "duration": duration,
            "sample_rate": sr,
            "speaker": args.speaker,
            "language": args.language,
            "speed": args.speed,
            "model": args.model,
            "device": str(model.device),
        }
        print(json.dumps(metadata), file=sys.stderr)
        
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
