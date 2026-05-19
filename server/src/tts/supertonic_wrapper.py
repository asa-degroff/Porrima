#!/usr/bin/env python3
"""
Supertonic 3 TTS wrapper for quje-agent.
Generates WAV audio from text and outputs to stdout.
"""

import argparse
import io
import json
import os
import math
import subprocess
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
    parser.add_argument("--pitch", type=float, default=1.0, help="Deprecated pitch multiplier; use --pitch-semitones")
    parser.add_argument("--pitch-semitones", type=float, default=None, help="Pitch shift in semitones")
    parser.add_argument(
        "--pitch-processor",
        default=os.environ.get("SUPERTONIC_TTS_PITCH_PROCESSOR", "rubberband"),
        choices=("resample", "rubberband"),
        help="Pitch shift processor",
    )
    parser.add_argument("--lang", default=os.environ.get("SUPERTONIC_TTS_LANG", "en"), help="Language code")
    parser.add_argument("--steps", type=int, default=int(os.environ.get("SUPERTONIC_TTS_STEPS", "8")), help="Quality steps")
    parser.add_argument("--max-chunk-length", type=int, default=int(os.environ.get("SUPERTONIC_TTS_MAX_CHUNK_LENGTH", "300")), help="Max characters per chunk")
    parser.add_argument("--silence-duration", type=float, default=float(os.environ.get("SUPERTONIC_TTS_SILENCE_DURATION", "0.3")), help="Silence between chunks in seconds")
    parser.add_argument("--trailing-silence", type=float, default=float(os.environ.get("SUPERTONIC_TTS_TRAILING_SILENCE", "0.1")), help="Silence appended to the end in seconds")
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
        pitch_semitones = args.pitch_semitones
        if pitch_semitones is None:
            pitch_semitones = 12 * math.log2(args.pitch) if args.pitch > 0 else 0.0

        if abs(pitch_semitones) >= 0.05:
            native_buffer = io.BytesIO()
            sf.write(native_buffer, audio, sample_rate, format="WAV", subtype="FLOAT")
            pitch_ratio = 2 ** (pitch_semitones / 12)

            if args.pitch_processor == "rubberband":
                filter_args = ":".join(
                    [
                        f"pitch={pitch_ratio:.8f}",
                        "pitchq=quality",
                        "formant=preserved",
                    ]
                )
                pitch_filter = f"rubberband={filter_args}"
            else:
                shifted_rate = max(1000, int(round(sample_rate * pitch_ratio)))
                tempo = 1 / pitch_ratio
                pitch_filter = f"asetrate={shifted_rate},aresample={sample_rate}:resampler=soxr:precision=28,atempo={tempo:.8f}"

            process = subprocess.Popen(
                [
                    "ffmpeg",
                    "-loglevel",
                    "error",
                    "-i",
                    "pipe:0",
                    "-filter:a",
                    pitch_filter,
                    "-f",
                    "wav",
                    "pipe:1",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            out, err = process.communicate(input=native_buffer.getvalue())
            if process.returncode != 0:
                raise RuntimeError(f"FFmpeg pitch processing failed: {err.decode().strip()}")

            processed_audio, processed_rate = sf.read(io.BytesIO(out), dtype="float32")
            audio = np.asarray(processed_audio).squeeze()
            sample_rate = int(processed_rate)

        if args.trailing_silence > 0:
            trailing_samples = int(sample_rate * args.trailing_silence)
            if trailing_samples > 0:
                audio = np.concatenate([audio, np.zeros(trailing_samples, dtype=audio.dtype)])

        wav_buffer = io.BytesIO()
        sf.write(wav_buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
        sys.stdout.buffer.write(wav_buffer.getvalue())
        sys.stdout.buffer.flush()

        metadata = {
            "duration": len(audio) / sample_rate,
            "sample_rate": sample_rate,
            "voice": args.voice,
            "speed": args.speed,
            "pitch_semitones": pitch_semitones,
            "pitch_processor": args.pitch_processor,
            "lang": args.lang,
            "steps": args.steps,
            "max_chunk_length": args.max_chunk_length,
            "silence_duration": args.silence_duration,
            "model_duration": _duration_value(duration),
            "trailing_silence": args.trailing_silence,
        }
        print(json.dumps(metadata), file=sys.stderr)
    except Exception as e:
        sys.stdout = _real_stdout
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
