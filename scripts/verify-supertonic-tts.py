#!/usr/bin/env python3
"""
Supertonic 3 TTS verification script.

Usage:
    python scripts/verify-supertonic-tts.py [--voice M1] [--json]
"""

import argparse
import json
import sys


def check_imports():
    print("Checking Python imports...", end=" ")
    try:
        import numpy  # noqa: F401
        import soundfile  # noqa: F401
        import supertonic  # noqa: F401
        print("ok")
        return {"success": True}
    except ImportError as e:
        print("failed")
        print(f"  Missing: {e.name}")
        return {"success": False, "error": str(e)}


def test_generation(voice: str):
    print(f"Testing generation with voice '{voice}'...", end=" ")
    try:
        from supertonic import TTS

        tts = TTS(auto_download=True)
        style = tts.get_voice_style(voice_name=voice)
        wav, duration = tts.synthesize(
            text="Hello from Supertonic 3. This is a verification test.",
            voice_style=style,
            total_steps=8,
            speed=1.05,
            lang="en",
            verbose=False,
        )

        duration_value = duration.tolist() if hasattr(duration, "tolist") else duration
        if isinstance(duration_value, list):
            duration_value = duration_value[0] if duration_value else 0

        if wav is None or getattr(wav, "size", 0) == 0:
            print("failed")
            return {"success": False, "error": "No audio generated"}

        print("ok")
        print(f"  Duration: {float(duration_value):.2f}s")
        print("  Sample rate: 44100 Hz")
        return {"success": True, "duration": float(duration_value), "sample_rate": 44100, "voice": voice}
    except Exception as e:
        print("failed")
        print(f"  Error: {e}")
        return {"success": False, "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Verify Supertonic 3 TTS installation")
    parser.add_argument("--voice", default="M1", help="Voice style to test (default: M1)")
    parser.add_argument("--json", action="store_true", help="Output result JSON")
    args = parser.parse_args()

    results = {
        "imports": check_imports(),
    }

    if results["imports"]["success"]:
        results["generation"] = test_generation(args.voice)
    else:
        results["generation"] = {"success": False, "error": "Import check failed"}

    if args.json:
        print(json.dumps(results, indent=2))

    if not results["imports"]["success"] or not results["generation"]["success"]:
        sys.exit(1)

    print("\nAll Supertonic 3 checks passed.")


if __name__ == "__main__":
    main()
