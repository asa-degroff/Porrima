#!/usr/bin/env python3
"""
Qwen3-TTS Verification Script

Tests the Qwen3-TTS installation and model availability.
Run this after install-qwen3-tts.sh to verify everything works.

Usage:
    python scripts/verify-qwen3-tts.py [--model MODEL_ID]
"""

import argparse
import sys
import json
from pathlib import Path

def check_imports():
    """Verify required packages are importable."""
    print("Checking Python imports...", end=" ")
    
    try:
        import qwen_tts
        import torch
        import soundfile
        print("✓")
        return {
            "qwen_tts": True,
            "torch": True,
            "soundfile": True,
        }
    except ImportError as e:
        print("✗")
        print(f"  Missing: {e.name}")
        return False


def check_model(model_id: str):
    """Check if model can be loaded."""
    print(f"Checking model: {model_id}...", end=" ")
    
    try:
        from qwen_tts import Qwen3TTSModel
        
        # Try to load model (will use cache if available)
        model = Qwen3TTSModel.from_pretrained(model_id)
        
        result = {
            "loaded": True,
            "model_id": model_id,
        }
        
        # Get device info (works for both GPU and CPU)
        try:
            result["device"] = str(model.device)
        except AttributeError:
            result["device"] = "unknown"
        
        # Get dtype if available
        try:
            result["dtype"] = str(model.dtype)
        except AttributeError:
            result["dtype"] = "unknown"
        
        print("✓")
        print(f"  Device: {result['device']}")
        print(f"  Dtype: {result['dtype']}")
        
        return result
        
    except Exception as e:
        print("✗")
        print(f"  Error: {e}")
        return {"loaded": False, "error": str(e)}


def test_generation(model_id: str, speaker: str = "Ryan"):
    """Test audio generation."""
    print(f"Testing generation with speaker '{speaker}'...", end=" ")
    
    try:
        from qwen_tts import Qwen3TTSModel
        import torch
        
        model = Qwen3TTSModel.from_pretrained(model_id)
        
        test_text = "Hello from Qwen3-TTS! This is a verification test."
        
        wavs, sr = model.generate_custom_voice(
            text=test_text,
            language="English",
            speaker=speaker,
        )
        
        if wavs is None or len(wavs) == 0:
            print("✗")
            print("  No audio generated")
            return {"success": False, "error": "No audio generated"}
        
        duration = len(wavs[0]) / sr
        
        print("✓")
        print(f"  Duration: {duration:.2f}s")
        print(f"  Sample rate: {sr} Hz")
        print(f"  Audio shape: {list(wavs[0].shape)}")
        
        return {
            "success": True,
            "duration": duration,
            "sample_rate": sr,
            "speaker": speaker,
        }
        
    except Exception as e:
        print("✗")
        print(f"  Error: {e}")
        return {"success": False, "error": str(e)}


def list_speakers(model_id: str):
    """List available speakers for the model."""
    print("Listing available speakers...", end=" ")
    
    try:
        from qwen_tts import Qwen3TTSModel
        
        model = Qwen3TTSModel.from_pretrained(model_id)
        speakers = model.get_supported_speakers()
        
        print("✓")
        for speaker in speakers:
            print(f"  - {speaker}")
        
        return {"speakers": speakers}
        
    except Exception as e:
        print("✗")
        print(f"  Error: {e}")
        return {"speakers": [], "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Verify Qwen3-TTS installation")
    parser.add_argument(
        "--model",
        default="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
        help="HuggingFace model ID (default: Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice)"
    )
    parser.add_argument(
        "--speaker",
        default="Ryan",
        help="Speaker to test (default: Ryan)"
    )
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Skip model download test"
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output as JSON"
    )
    
    args = parser.parse_args()
    
    results = {
        "imports": check_imports(),
    }
    
    if not results["imports"]:
        print("\n✗ Import check failed. Please install required packages.")
        print("  Run: pip install qwen-tts torch soundfile")
        sys.exit(1)
    
    if not args.skip_download:
        results["model"] = check_model(args.model)
        
        if not results["model"].get("loaded"):
            print("\n✗ Model load failed.")
            print("  Run the install script: ./scripts/install-qwen3-tts.sh")
            sys.exit(1)
        
        results["speakers"] = list_speakers(args.model)
        results["generation"] = test_generation(args.model, args.speaker)
    
    if args.json:
        print("\n" + json.dumps(results, indent=2))
    else:
        print("\n" + "=" * 50)
        print("Verification Summary")
        print("=" * 50)
        
        if all([
            results["imports"],
            results.get("model", {}).get("loaded"),
            results.get("generation", {}).get("success"),
        ]):
            print("✓ All checks passed!")
            print("\nQwen3-TTS is ready to use.")
        else:
            print("✗ Some checks failed.")
            print("\nPlease review the errors above.")
            sys.exit(1)


if __name__ == "__main__":
    main()
