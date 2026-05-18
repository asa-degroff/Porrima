#!/usr/bin/env python3
"""
Persistent Supertonic 3 TTS worker for quje-agent.
Runs as a long-lived process, reading JSON requests from stdin,
returning JSON responses with base64-encoded WAV on stdout.
Model stays loaded in memory between requests.

Protocol (one JSON object per line):
  Request:  {"id": <int>, "text": str, "voice": str, "speed": float, ...}
  Response: {"id": <int>, "audio": "<base64 wav>", "duration": float, "sampleRate": int}
  Error:    {"id": <int>, "error": str}
  Ready:    {"ready": true}  (sent on startup after model loads)
"""

import base64
import io
import json
import math
import os
import signal
import subprocess
import sys
import threading
import traceback

# Redirect import noise away from stdout (reserved for JSON protocol)
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


def _write_json(obj):
    """Write a JSON object to stdout, flushed immediately."""
    _real_stdout.write(json.dumps(obj) + "\n")
    _real_stdout.flush()


def _synthesize(text, voice, speed, pitch_semitones, pitch_processor,
                lang, steps, max_chunk_length, silence_duration, trailing_silence,
                tts_engine):
    """Core synthesis logic — shared between worker and CLI modes."""
    sys.stdout = sys.stderr
    style = tts_engine.get_voice_style(voice_name=voice)
    wav, duration = tts_engine.synthesize(
        text=text,
        voice_style=style,
        total_steps=steps,
        speed=speed,
        max_chunk_length=max_chunk_length,
        silence_duration=silence_duration,
        lang=lang,
        verbose=False,
    )
    sys.stdout = _real_stdout

    audio = np.asarray(wav).squeeze()
    if audio.size == 0:
        raise ValueError("No audio generated")

    sample_rate = 44100

    if abs(pitch_semitones) >= 0.05:
        native_buffer = io.BytesIO()
        sf.write(native_buffer, audio, sample_rate, format="WAV", subtype="FLOAT")
        pitch_ratio = 2 ** (pitch_semitones / 12)

        if pitch_processor == "rubberband":
            filter_args = ":".join([
                f"pitch={pitch_ratio:.8f}",
                "pitchq=quality",
                "formant=preserved",
            ])
            pitch_filter = f"rubberband={filter_args}"
        else:
            shifted_rate = max(1000, int(round(sample_rate * pitch_ratio)))
            tempo = 1 / pitch_ratio
            pitch_filter = (
                f"asetrate={shifted_rate},"
                f"aresample={sample_rate}:resampler=soxr:precision=28,"
                f"atempo={tempo:.8f}"
            )

        process = subprocess.Popen(
            [
                "ffmpeg", "-loglevel", "error",
                "-i", "pipe:0",
                "-filter:a", pitch_filter,
                "-f", "wav", "pipe:1",
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

    if trailing_silence > 0:
        trailing_samples = int(sample_rate * trailing_silence)
        if trailing_samples > 0:
            audio = np.concatenate([audio, np.zeros(trailing_samples, dtype=audio.dtype)])

    wav_buffer = io.BytesIO()
    sf.write(wav_buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
    wav_bytes = wav_buffer.getvalue()

    return wav_bytes, len(audio) / sample_rate, sample_rate, _duration_value(duration)


class SupertonicWorker:
    """Long-lived worker: loads model once, processes requests from stdin."""

    def __init__(self):
        self.tts = None
        self.request_id = 0
        self._shutdown = False

    def load_model(self):
        print("[Supertonic-Worker] Loading TTS engine...", file=sys.stderr)
        sys.stdout = sys.stderr
        self.tts = TTS(auto_download=True)
        sys.stdout = _real_stdout
        print("[Supertonic-Worker] Model loaded.", file=sys.stderr)

    def handle_request(self, req):
        req_id = req.get("id", 0)
        try:
            text = req["text"]
            voice = req.get("voice", "M1")
            speed = req.get("speed", 1.05)
            lang = req.get("lang", "en")
            steps = req.get("steps", 8)
            max_chunk_length = req.get("maxChunkLength", 300)
            silence_duration = req.get("silenceDuration", 0.3)
            trailing_silence = req.get("trailingSilence", 0.1)
            pitch_semitones = req.get("pitchSemitones", 0.0)
            pitch_processor = req.get("pitchProcessor", "resample")

            # Backward compat: if pitch multiplier provided instead
            if "pitch" in req and pitch_semitones == 0.0:
                pitch = req["pitch"]
                if pitch and pitch > 0:
                    pitch_semitones = 12 * math.log2(pitch)

            wav_bytes, duration, sample_rate, model_duration = _synthesize(
                text=text,
                voice=voice,
                speed=speed,
                pitch_semitones=pitch_semitones,
                pitch_processor=pitch_processor,
                lang=lang,
                steps=steps,
                max_chunk_length=max_chunk_length,
                silence_duration=silence_duration,
                trailing_silence=trailing_silence,
                tts_engine=self.tts,
            )

            audio_b64 = base64.b64encode(wav_bytes).decode("ascii")

            _write_json({
                "id": req_id,
                "audio": audio_b64,
                "duration": duration,
                "sampleRate": sample_rate,
                "modelDuration": model_duration,
                "size": len(wav_bytes),
            })

        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            _write_json({"id": req_id, "error": str(e)})

    def run(self):
        # Handle graceful shutdown
        def _handle_signal(signum, frame):
            self._shutdown = True

        signal.signal(signal.SIGTERM, _handle_signal)
        signal.signal(signal.SIGINT, _handle_signal)

        self.load_model()
        _write_json({"ready": True})

        print("[Supertonic-Worker] Waiting for requests on stdin...", file=sys.stderr)

        buf = ""
        while not self._shutdown:
            try:
                chunk = sys.stdin.readline()
                if not chunk:
                    break  # EOF
                buf += chunk
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        req = json.loads(line)
                        if "id" in req:
                            self.handle_request(req)
                        elif req.get("ping"):
                            _write_json({"pong": True})
                        else:
                            _write_json({"error": "Unknown message format"})
                    except json.JSONDecodeError:
                        print(f"[Supertonic-Worker] Invalid JSON: {line[:80]}", file=sys.stderr)
            except Exception as e:
                print(f"[Supertonic-Worker] Read error: {e}", file=sys.stderr)
                break

        print("[Supertonic-Worker] Shutting down.", file=sys.stderr)


def main():
    worker = SupertonicWorker()
    worker.run()


if __name__ == "__main__":
    main()
