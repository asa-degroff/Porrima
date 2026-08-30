#!/usr/bin/env python3
"""
Persistent Kokoro TTS worker for Porrima.
Runs as a long-lived process, reading JSON requests from stdin,
returning JSON responses with base64-encoded WAV on stdout.
Pipelines stay loaded in memory between requests, eliminating the
per-request Python/torch import and model load cost (~3s).

Protocol (one JSON object per line):
  Request:  {"id": <int>, "text": str, "voice": str, "speed": float, "pitch": float, ...}
  Response: {"id": <int>, "audio": "<base64 wav>", "duration": float, "sampleRate": int}
  Error:    {"id": <int>, "error": str}
  Ready:    {"ready": true}  (sent on startup after pipelines load)
"""

import base64
import io
import json
import signal
import subprocess
import sys
import traceback
import wave

# Redirect import noise away from stdout (reserved for JSON protocol)
_real_stdout = sys.stdout
sys.stdout = sys.stderr

import numpy as np
from kokoro import KPipeline

sys.stdout = _real_stdout

SAMPLE_RATE = 24000
FADE_DURATION = 0.05  # 50ms fade-out


def _write_json(obj):
    """Write a JSON object to stdout, flushed immediately."""
    _real_stdout.write(json.dumps(obj) + "\n")
    _real_stdout.flush()


def _infer_lang_code(voice, lang):
    if voice.startswith("bf_") or voice.startswith("bm_"):
        return "b"
    if voice.startswith("af_") or voice.startswith("am_"):
        return "a"
    return lang or "a"


def _apply_fade(audio):
    """Apply an exponential fade-out to the tail of float32 audio to prevent clicks."""
    fade_samples = int(SAMPLE_RATE * FADE_DURATION)
    if len(audio) > fade_samples:
        fade_curve = np.ones(fade_samples)
        exp_portion = np.exp(np.linspace(0, -3, fade_samples - 1))
        fade_curve[:-1] = exp_portion
        fade_curve[-1] = 0.0
        audio[-fade_samples:] *= fade_curve
    elif len(audio) > 0:
        fade_curve = np.zeros(len(audio))
        if len(audio) > 1:
            exp_portion = np.exp(np.linspace(0, -3, len(audio) - 1))
            fade_curve[:-1] = exp_portion
        fade_curve[-1] = 0.0
        audio *= fade_curve
    return audio


def _int16_wav_bytes(audio):
    audio_int16 = (audio * 32767).clip(-32768, 32767).astype("int16")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(audio_int16.tobytes())
    return buffer.getvalue()


def _atempo_chain(tempo):
    filters = []
    while tempo < 0.5:
        filters.append("atempo=0.5")
        tempo /= 0.5
    while tempo > 2.0:
        filters.append("atempo=2.0")
        tempo /= 2.0
    filters.append(f"atempo={tempo:.8f}")
    return filters


class KokoroWorker:
    """Long-lived worker: loads pipelines once, processes requests from stdin."""

    def __init__(self):
        self.pipelines = {}
        self._shutdown = False

    def get_pipeline(self, lang_code):
        if lang_code not in self.pipelines:
            print(f"[Kokoro-Worker] Loading pipeline for lang_code={lang_code}...", file=sys.stderr)
            sys.stdout = sys.stderr
            try:
                self.pipelines[lang_code] = KPipeline(lang_code=lang_code)
            finally:
                sys.stdout = _real_stdout
            print(f"[Kokoro-Worker] Pipeline loaded for lang_code={lang_code}.", file=sys.stderr)
        return self.pipelines[lang_code]

    def synthesize(self, text, voice, speed, pitch, pitch_processor, lang):
        """Core synthesis — mirrors kokoro_wrapper.py behavior.

        Returns (wav_bytes, duration_seconds, sample_rate).
        """
        lang_code = _infer_lang_code(voice, lang)
        pipeline = self.get_pipeline(lang_code)

        # Generate audio at native speed (1.0) to avoid generation-time artifacts.
        # Kokoro's internal speed parameter causes pitch/timing artifacts, so
        # ffmpeg's atempo filter handles pitch-corrected speed adjustment instead.
        sys.stdout = sys.stderr
        try:
            all_audio = [segment.audio for segment in pipeline(text, voice=voice, speed=1.0)]
        finally:
            sys.stdout = _real_stdout

        if not all_audio:
            raise ValueError("No audio generated")

        audio = np.concatenate(all_audio)

        # Neutral speed + pitch: output native audio directly with a fade-out.
        if abs(speed - 1.0) < 0.01 and abs(pitch - 1.0) < 0.001:
            audio = _apply_fade(audio)
            wav_bytes = _int16_wav_bytes(audio)
            return wav_bytes, len(audio) / SAMPLE_RATE, SAMPLE_RATE

        # ffmpeg post-processing path. Fade is applied in numpy afterwards
        # because atempo changes the sample count and ffmpeg's afade timing is unreliable.
        filters = []
        pitch_changed = abs(pitch - 1.0) >= 0.001

        if pitch_processor == "rubberband" and pitch_changed:
            # Rubberband: pitch and speed are independent.
            filter_args = ":".join([
                f"pitch={pitch:.8f}",
                "pitchq=quality",
                "formant=preserved",
            ])
            filters.append(f"rubberband={filter_args}")
            tempo = speed
        else:
            # Resample path: asetrate changes pitch, aresample restores sample rate,
            # atempo compensates both speed and pitch-induced duration change.
            if pitch_changed:
                shifted_rate = max(1000, int(round(SAMPLE_RATE * pitch)))
                filters.extend([
                    f"asetrate={shifted_rate}",
                    f"aresample={SAMPLE_RATE}:resampler=soxr:precision=28",
                ])
                tempo = speed / pitch
            else:
                tempo = speed

        filters.extend(_atempo_chain(tempo))

        process = subprocess.Popen(
            [
                "ffmpeg",
                "-loglevel", "error",
                "-i", "pipe:0",
                "-filter:a", ",".join(filters),
                "-f", "wav",
                "pipe:1",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        out, err = process.communicate(input=_int16_wav_bytes(audio))

        if process.returncode != 0:
            raise RuntimeError(f"FFmpeg error: {err.decode()}")

        with wave.open(io.BytesIO(out), "rb") as wav_file:
            n_channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            sample_rate = wav_file.getframerate()
            raw_data = wav_file.readframes(wav_file.getnframes())

        processed_audio = np.frombuffer(raw_data, dtype=np.int16).copy()

        # Apply fade-out with precise sample-level control.
        fade_samples = int(sample_rate * FADE_DURATION)
        if len(processed_audio) > fade_samples:
            fade_curve = np.ones(fade_samples, dtype=np.float64)
            if fade_samples > 1:
                exp_portion = np.exp(np.linspace(0, -3, fade_samples - 1))
                fade_curve[:-1] = exp_portion
            fade_curve[-1] = 0.0
            processed_audio[-fade_samples:] = (
                processed_audio[-fade_samples:].astype(np.float64) * fade_curve
            ).astype(np.int16)
        elif len(processed_audio) > 0:
            fade_curve = np.zeros(len(processed_audio), dtype=np.float64)
            if len(processed_audio) > 1:
                exp_portion = np.exp(np.linspace(0, -3, len(processed_audio) - 1))
                fade_curve[:-1] = exp_portion
            fade_curve[-1] = 0.0
            processed_audio = (processed_audio.astype(np.float64) * fade_curve).astype(np.int16)

        output_buffer = io.BytesIO()
        with wave.open(output_buffer, "wb") as out_wav:
            out_wav.setnchannels(n_channels)
            out_wav.setsampwidth(sample_width)
            out_wav.setframerate(sample_rate)
            out_wav.writeframes(processed_audio.tobytes())

        wav_bytes = output_buffer.getvalue()
        return wav_bytes, len(processed_audio) / sample_rate, sample_rate

    def handle_request(self, req):
        req_id = req.get("id", 0)
        try:
            wav_bytes, duration, sample_rate = self.synthesize(
                text=req["text"],
                voice=req.get("voice", "af_heart"),
                speed=req.get("speed", 1.0),
                pitch=req.get("pitch", 1.0),
                pitch_processor=req.get("pitchProcessor", "resample"),
                lang=req.get("lang"),
            )

            _write_json({
                "id": req_id,
                "audio": base64.b64encode(wav_bytes).decode("ascii"),
                "duration": duration,
                "sampleRate": sample_rate,
                "size": len(wav_bytes),
            })

        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            _write_json({"id": req_id, "error": str(e)})

    def run(self):
        def _handle_signal(signum, frame):
            self._shutdown = True

        signal.signal(signal.SIGTERM, _handle_signal)
        signal.signal(signal.SIGINT, _handle_signal)

        self.get_pipeline("a")
        _write_json({"ready": True})

        print("[Kokoro-Worker] Waiting for requests on stdin...", file=sys.stderr)

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
                        print(f"[Kokoro-Worker] Invalid JSON: {line[:80]}", file=sys.stderr)
            except Exception as e:
                print(f"[Kokoro-Worker] Read error: {e}", file=sys.stderr)
                break

        print("[Kokoro-Worker] Shutting down.", file=sys.stderr)


def main():
    worker = KokoroWorker()
    worker.run()


if __name__ == "__main__":
    main()
