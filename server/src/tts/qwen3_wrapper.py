#!/usr/bin/env python3
"""
Qwen3-TTS wrapper for quje-agent.
Generates WAV audio from text and outputs to stdout.

Usage:
    python qwen3_wrapper.py --text "Hello world" --speaker Ryan --speed 1.0

Output:
    Binary WAV data to stdout
    Metadata JSON to stderr

Requires:
    pip install qwen-tts torch soundfile
"""

import argparse
import json
import os
import sys
import io

import torch
import soundfile as sf
from qwen_tts import Qwen3TTSModel


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
        # Check if model is already loaded via environment variable
        model = getattr(main, '_model', None)
        if model is None:
            print(f"[Qwen3-TTS] Loading model: {args.model}", file=sys.stderr)

            # Detect device: ROCm (AMD GPU) or CUDA (NVIDIA) or CPU
            if torch.cuda.is_available():
                device_map = "cuda:0"
                gpu_name = torch.cuda.get_device_name(0)
                print(f"[Qwen3-TTS] Using GPU: {gpu_name}", file=sys.stderr)

                if torch.version.hip:
                    # ROCm (AMD): float16 crashes on RDNA3 (gfx1100), use bfloat16
                    dtype = torch.bfloat16
                    attn_impl = os.environ.get("QWEN_TTS_ATTN", "eager")
                    if attn_impl == "sdpa":
                        os.environ["TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL"] = "1"
                    print(f"[Qwen3-TTS] ROCm mode: bfloat16 + {attn_impl}", file=sys.stderr)
                else:
                    # CUDA (NVIDIA): use bfloat16, flash_attention_2
                    dtype = torch.bfloat16
                    attn_impl = "flash_attention_2"
            else:
                device_map = "cpu"
                dtype = torch.float32
                attn_impl = "eager"
                print("[Qwen3-TTS] No GPU detected, using CPU", file=sys.stderr)
            
            model = Qwen3TTSModel.from_pretrained(
                args.model,
                device_map=device_map,
                dtype=dtype,
                attn_implementation=attn_impl,
            )
            main._model = model  # Cache for reuse
            print(f"[Qwen3-TTS] Model loaded on {device_map} with dtype {dtype}", file=sys.stderr)
        
        # Generate audio
        wavs, sr = model.generate_custom_voice(
            text=args.text,
            language=args.language,
            speaker=args.speaker,
            instruct=args.instruct if args.instruct else None,
        )
        
        if wavs is None or len(wavs) == 0:
            raise ValueError("No audio generated")
        
        # wavs is already in WAV format with header from Qwen3TTS
        # Convert to bytes
        wav_buffer = io.BytesIO()
        sf.write(wav_buffer, wavs[0], sr, format='WAV')
        
        # Write binary WAV data to stdout
        sys.stdout.buffer.write(wav_buffer.getvalue())
        sys.stdout.buffer.flush()
        
        # Write metadata to stderr as JSON
        duration = len(wavs[0]) / sr
        
        # Get dtype safely (may not be available on all versions)
        try:
            dtype = str(model.dtype)
        except AttributeError:
            dtype = "unknown"
        
        metadata = {
            "duration": duration,
            "sample_rate": sr,
            "speaker": args.speaker,
            "language": args.language,
            "speed": args.speed,
            "model": args.model,
            "dtype": dtype,
            "device": str(model.device),
        }
        print(json.dumps(metadata), file=sys.stderr)
        
    except Exception as e:
        # Write error to stderr
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
