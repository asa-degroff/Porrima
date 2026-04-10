#!/usr/bin/env python3
"""
Kokoro TTS wrapper for quje-agent.
Generates WAV audio from text and outputs to stdout.
"""

import argparse
import json
import sys
import wave
import io
import subprocess
import numpy as np
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
        
        # Generate audio at native speed (1.0) to avoid generation-time artifacts
        # Kokoro's internal speed parameter causes pitch/timing artifacts.
        # We will use ffmpeg's atempo filter for pitch-corrected speed adjustment.
        all_audio = []
        sample_rate = 24000

        for segment in pipeline(args.text, voice=args.voice, speed=1.0):
            all_audio.append(segment.audio)
        
        if not all_audio:
            raise ValueError("No audio generated")
        
        # Concatenate all audio segments
        audio = np.concatenate(all_audio)
        
        # Convert float32 to int16 for WAV storage
        audio_int16 = (audio * 32767).clip(-32768, 32767).astype("int16")
        
        # Write native audio to an in-memory buffer
        native_buffer = io.BytesIO()
        with wave.open(native_buffer, "wb") as wav_file:
            wav_file.setnchannels(1)  # Mono
            wav_file.setsampwidth(2)  # 16-bit
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio_int16.tobytes())
        native_buffer.seek(0)

        # If speed is 1.0, just output the native audio directly
        if abs(args.speed - 1.0) < 0.01:
            sys.stdout.buffer.write(native_buffer.getvalue())
            sys.stdout.buffer.flush()
            duration = len(audio) / sample_rate
            metadata = {
                "duration": duration,
                "sample_rate": sample_rate,
                "voice": args.voice,
                "speed": args.speed,
                "lang_code": lang_code,
            }
            print(json.dumps(metadata), file=sys.stderr)
        else:
            # Use ffmpeg to change speed with pitch correction (atempo)
            # atempo filter works in range [0.5, 2.0]
            # We handle the speed adjustment via a subprocess pipe
            
            # Construct the ffmpeg command
            # We use -filter:a atempo=X to adjust speed without changing pitch
            cmd = [
                "ffmpeg",
                "-loglevel", "error",
                "-i", "pipe:0",
                "-filter:a", f"atempo={args.speed}",
                "-f", "wav",
                "pipe:1"
            ]
            
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            out, err = process.communicate(input=native_buffer.getvalue())
            
            if process.returncode != 0:
                raise RuntimeError(f"FFmpeg error: {err.decode()}")

            # Write the processed audio to stdout
            sys.stdout.buffer.write(out)
            sys.stdout.buffer.flush()
            
            # Calculate expected duration (original duration / speed)
            duration = (len(audio) / sample_rate) / args.speed
            
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
