#!/usr/bin/env python3
"""
Kokoro TTS wrapper for quje-agent.
Generates WAV audio from text and outputs to stdout.
"""

import argparse
import io
import json
import subprocess
import sys
import wave
import numpy as np
from kokoro import KPipeline


def main():
    parser = argparse.ArgumentParser(description="Generate TTS audio using Kokoro")
    parser.add_argument("--text", required=True, help="Text to synthesize")
    parser.add_argument("--voice", default="af_heart", help="Voice ID (default: af_heart)")
    parser.add_argument("--speed", type=float, default=1.0, help="Speed multiplier (default: 1.0)")
    parser.add_argument("--pitch", type=float, default=1.0, help="Pitch multiplier (default: 1.0)")
    parser.add_argument("--pitch-processor", default="resample", choices=("resample", "rubberband"),
                        help="Pitch shift processor (default: resample)")
    parser.add_argument("--lang", default="a", help="Language code: 'a'=American, 'b'=British (default: a)")
    args = parser.parse_args()

    # Configuration for click prevention
    FADE_DURATION = 0.05  # 50ms fade-out

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
        # Note: We don't apply fade here when using ffmpeg path - ffmpeg will handle it
        # with correct timing after atempo processing
        audio_int16 = (audio * 32767).clip(-32768, 32767).astype("int16")
        
        # Write native audio to an in-memory buffer
        native_buffer = io.BytesIO()
        with wave.open(native_buffer, "wb") as wav_file:
            wav_file.setnchannels(1)  # Mono
            wav_file.setsampwidth(2)  # 16-bit
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio_int16.tobytes())
        native_buffer.seek(0)

        def atempo_chain(tempo):
            filters = []
            while tempo < 0.5:
                filters.append("atempo=0.5")
                tempo /= 0.5
            while tempo > 2.0:
                filters.append("atempo=2.0")
                tempo /= 2.0
            filters.append(f"atempo={tempo:.8f}")
            return filters

        # If speed and pitch are neutral, output the native audio directly.
        if abs(args.speed - 1.0) < 0.01 and abs(args.pitch - 1.0) < 0.001:
            # Apply fade-out to prevent click at end
            fade_samples = int(sample_rate * FADE_DURATION)
            if len(audio) > fade_samples:
                # Use exponential fade that reaches zero for natural sound
                # exp(-3) ≈ 0.05, so we scale to ensure it reaches 0 at the end
                fade_curve = np.ones(fade_samples)
                exp_portion = np.exp(np.linspace(0, -3, fade_samples - 1))
                fade_curve[:-1] = exp_portion
                fade_curve[-1] = 0.0  # Ensure absolute zero at the very end
                audio[-fade_samples:] *= fade_curve
            elif len(audio) > 0:
                fade_curve = np.zeros(len(audio))
                if len(audio) > 1:
                    exp_portion = np.exp(np.linspace(0, -3, len(audio) - 1))
                    fade_curve[:-1] = exp_portion
                fade_curve[-1] = 0.0
                audio *= fade_curve
            
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
            
            sys.stdout.buffer.write(native_buffer.getvalue())
            sys.stdout.buffer.flush()
            duration = len(audio) / sample_rate
            metadata = {
                "duration": duration,
                "sample_rate": sample_rate,
                "voice": args.voice,
                "speed": args.speed,
                "pitch": args.pitch,
                "lang_code": lang_code,
            }
            print(json.dumps(metadata), file=sys.stderr)
        else:
            # Use ffmpeg for post-processing.
            # We use a subprocess pipe to feed the native audio into ffmpeg.
            # NOTE: We do NOT apply fade in ffmpeg - we'll do it in numpy after processing
            # because atempo changes the sample count and ffmpeg's afade timing is unreliable.
            #
            # Two pitch shift processors:
            #   "resample" - asetrate + aresample + atempo (changes timbre with pitch)
            #   "rubberband" - rubberband filter with formant preservation + atempo for speed
            filters = []
            pitch_changed = abs(args.pitch - 1.0) >= 0.001

            if args.pitch_processor == "rubberband" and pitch_changed:
                # Rubberband: pitch and speed are independent.
                # rubberband handles pitch with formant preservation.
                # atempo handles speed separately.
                pitch_ratio = args.pitch
                filter_args = ":".join([
                    f"pitch={pitch_ratio:.8f}",
                    "pitchq=quality",
                    "formant=preserved",
                ])
                filters.append(f"rubberband={filter_args}")
                tempo = args.speed
            else:
                # Resample path: asetrate changes pitch, aresample restores sample rate,
                # atempo compensates both speed and pitch-induced duration change.
                if pitch_changed:
                    shifted_rate = max(1000, int(round(sample_rate * args.pitch)))
                    filters.extend([
                        f"asetrate={shifted_rate}",
                        f"aresample={sample_rate}:resampler=soxr:precision=28",
                    ])
                    tempo = args.speed / args.pitch
                else:
                    tempo = args.speed

            filters.extend(atempo_chain(tempo))
            
            cmd = [
                "ffmpeg",
                "-loglevel", "error",
                "-i", "pipe:0",
                "-filter:a", ",".join(filters),
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

            # Parse the processed WAV to get the audio samples
            # We need to apply the fade in numpy for precise control
            processed_buffer = io.BytesIO(out)
            with wave.open(processed_buffer, "rb") as wav_file:
                n_channels = wav_file.getnchannels()
                sample_width = wav_file.getsampwidth()
                sample_rate = wav_file.getframerate()
                n_frames = wav_file.getnframes()
                
                # Read all frames
                raw_data = wav_file.readframes(n_frames)
                
                # Convert to numpy array (int16) and make a writable copy
                processed_audio = np.frombuffer(raw_data, dtype=np.int16).copy()
                
                # Apply fade-out to the last FADE_DURATION seconds
                fade_samples = int(sample_rate * FADE_DURATION)
                if len(processed_audio) > fade_samples:
                    # Create exponential fade curve that reaches exactly zero
                    fade_curve = np.ones(fade_samples, dtype=np.float64)
                    if fade_samples > 1:
                        exp_portion = np.exp(np.linspace(0, -3, fade_samples - 1))
                        fade_curve[:-1] = exp_portion
                    fade_curve[-1] = 0.0  # Ensure absolute zero at the very end
                    
                    # Apply fade to the end of the audio
                    processed_audio[-fade_samples:] = (
                        processed_audio[-fade_samples:].astype(np.float64) * fade_curve
                    ).astype(np.int16)
                elif len(processed_audio) > 0:
                    # Audio is shorter than fade duration, fade the whole thing
                    fade_curve = np.zeros(len(processed_audio), dtype=np.float64)
                    if len(processed_audio) > 1:
                        exp_portion = np.exp(np.linspace(0, -3, len(processed_audio) - 1))
                        fade_curve[:-1] = exp_portion
                    fade_curve[-1] = 0.0
                    processed_audio = (processed_audio.astype(np.float64) * fade_curve).astype(np.int16)
                
                # Write the faded audio to a new WAV buffer
                output_buffer = io.BytesIO()
                with wave.open(output_buffer, "wb") as out_wav:
                    out_wav.setnchannels(n_channels)
                    out_wav.setsampwidth(sample_width)
                    out_wav.setframerate(sample_rate)
                    out_wav.writeframes(processed_audio.tobytes())
                
                # Output the final audio
                sys.stdout.buffer.write(output_buffer.getvalue())
                sys.stdout.buffer.flush()
                
                # Calculate duration based on processed sample count
                duration = len(processed_audio) / sample_rate
                
                metadata = {
                    "duration": duration,
                    "sample_rate": sample_rate,
                    "voice": args.voice,
                    "speed": args.speed,
                    "pitch": args.pitch,
                    "lang_code": lang_code,
                }
                print(json.dumps(metadata), file=sys.stderr)
        
    except Exception as e:
        # Write error to stderr
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
