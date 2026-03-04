#!/usr/bin/env python3
"""
Kokoro TTS wrapper for quje-agent.
Generates WAV audio from text and outputs to stdout.

Usage:
    python kokoro_wrapper.py --text "Hello world" --voice af_heart --speed 1.0

Output:
    Binary WAV data to stdout
    Metadata JSON to stderr
"""

import argparse
import json
import sys
import wave
import io

from kokoro import KPipeline


def main():
    parser = argparse.ArgumentParser(description="Generate TTS audio using Kokoro")
    parser.add_argument("--text", required=True, help="Text to synthesize")
    parser.add_argument("--voice", default="af_heart", help="Voice ID (default: af_heart)")
    parser.add_argument("--speed", type=float, default=1.0, help="Speed multiplier (default: 1.0)")
    parser.add_argument("--lang", default="a", help="Language code: 'a'=American, 'b'=British (default: a)")
    args = parser.parse_args()

    try:
        # Determine language code from voice prefix
        # af_* or am_* = American ('a'), bf_* or bm_* = British ('b')
        lang_code = args.lang
        if args.voice.startswith('bf_') or args.voice.startswith('bm_'):
            lang_code = 'b'
        elif args.voice.startswith('af_') or args.voice.startswith('am_'):
            lang_code = 'a'

        # Load pipeline
        pipeline = KPipeline(lang_code=lang_code)
        
        # Generate audio
        # KPipeline returns an iterable of Result segments
        # Kokoro uses a fixed 24kHz sample rate
        all_audio = []
        sample_rate = 24000

        for segment in pipeline(args.text, voice=args.voice, speed=args.speed):
            all_audio.append(segment.audio)
        
        if not all_audio:
            raise ValueError("No audio generated")
        
        # Concatenate all audio segments
        import numpy as np
        audio = np.concatenate(all_audio)
        
        # Write WAV to stdout
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(1)  # Mono
            wav_file.setsampwidth(2)  # 16-bit
            wav_file.setframerate(sample_rate)
            
            # Convert float32 to int16
            audio_int16 = (audio * 32767).clip(-32768, 32767).astype("int16")
            wav_file.writeframes(audio_int16.tobytes())
        
        # Write binary WAV data to stdout
        sys.stdout.buffer.write(buffer.getvalue())
        sys.stdout.buffer.flush()
        
        # Write metadata to stderr as JSON
        duration = len(audio) / sample_rate
        metadata = {
            "duration": duration,
            "sample_rate": sample_rate,
            "voice": args.voice,
            "speed": args.speed,
            "lang_code": lang_code,
        }
        print(json.dumps(metadata), file=sys.stderr)
        
    except Exception as e:
        # Write error to stderr
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
