#!/usr/bin/env python3
"""
Supertonic 3 TTS wrapper for quje-agent.
Generates WAV audio from text and outputs to stdout.
"""

import argparse
import io
import json
import os
import sys

# Keep third-party import logs out of stdout, which must contain only WAV bytes.
_real_stdout = sys.stdout
sys.stdout = sys.stderr

import numpy as np
import soundfile as sf
from supertonic import TTS

sys.stdout = _real_stdout


def _duration_value(duration):
    if hasattr(duration, "tolist"):
        value = duration.tolist()
        if isinstance(value, list):
            return float(value[0]) if value else 0.0
        return float(value)
    if isinstance(duration, (list, tuple)):
        return float(duration[0]) if duration else 0.0
    return float(duration)


def main():
    parser = argparse.ArgumentParser(description="Generate TTS audio using Supertonic 3")
    parser.add_argument("--text", required=True, help="Text to synthesize")
    parser.add_argument("--voice", default="M1", help="Voice style ID (M1-M5, F1-F5)")
    parser.add_argument("--speed", type=float, default=1.05, help="Speed multiplier (0.7-2.0)")
    parser.add_argument("--lang", default=os.environ.get("SUPERTONIC_TTS_LANG", "en"), help="Language code")
    parser.add_argument("--steps", type=int, default=int(os.environ.get("SUPERTONIC_TTS_STEPS", "8")), help="Quality steps")
    parser.add_argument("--max-chunk-length", type=int, default=int(os.environ.get("SUPERTONIC_TTS_MAX_CHUNK_LENGTH", "300")), help="Max characters per chunk")
    parser.add_argument("--silence-duration", type=float, default=float(os.environ.get("SUPERTONIC_TTS_SILENCE_DURATION", "0.3")), help="Silence between chunks in seconds")
    args = parser.parse_args()

    try:
        tts = getattr(main, "_tts", None)
        if tts is None:
            print("[Supertonic] Loading TTS engine", file=sys.stderr)
            sys.stdout = sys.stderr
            tts = TTS(auto_download=True)
            sys.stdout = _real_stdout
            main._tts = tts

        sys.stdout = sys.stderr
        style = tts.get_voice_style(voice_name=args.voice)
        wav, duration = tts.synthesize(
            text=args.text,
            voice_style=style,
            total_steps=args.steps,
            speed=args.speed,
            max_chunk_length=args.max_chunk_length,
            silence_duration=args.silence_duration,
            lang=args.lang,
            verbose=False,
        )
        sys.stdout = _real_stdout

        audio = np.asarray(wav).squeeze()
        if audio.size == 0:
            raise ValueError("No audio generated")

        sample_rate = 44100
        wav_buffer = io.BytesIO()
        sf.write(wav_buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
        sys.stdout.buffer.write(wav_buffer.getvalue())
        sys.stdout.buffer.flush()

        metadata = {
            "duration": _duration_value(duration),
            "sample_rate": sample_rate,
            "voice": args.voice,
            "speed": args.speed,
            "lang": args.lang,
            "steps": args.steps,
        }
        print(json.dumps(metadata), file=sys.stderr)
    except Exception as e:
        sys.stdout = _real_stdout
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
