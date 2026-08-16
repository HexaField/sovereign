#!/usr/bin/env python3
"""One-shot smoke test for F5-TTS on the ROCm iGPU.

Loads the base model, clones a voice from the configured reference clip,
and runs one short synthesis. Prints timing for each stage so load cost
and first-call (cold kernel) cost stay visible before the server wraps
this in a persistent process.

Run:
    HSA_USE_SVM=0 TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1 \
        .venv/bin/python smoke_test.py
"""
import os
import time

os.environ.setdefault("HSA_USE_SVM", "0")
os.environ.setdefault("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", "1")

import soundfile as sf
import torch
import torchaudio


def _patch_torchaudio_load() -> None:
    """Route torchaudio.load through soundfile instead of torchcodec.

    torchaudio 2.9 dispatches load() to torchcodec, which needs FFmpeg
    shared libraries not present on this system (static ffmpeg binary
    only, no libavcodec.so — the dev libs need sudo, out of scope here).
    f5_tts calls torchaudio.load() at exactly one site, for the known-
    format reference WAV, so a soundfile-backed loader covers it without
    a new native dependency.
    """
    import numpy as np

    def _load(filepath, *args, **kwargs):
        data, sr = sf.read(filepath, dtype="float32", always_2d=True)
        wav = torch.from_numpy(np.ascontiguousarray(data.T))
        return wav, sr

    torchaudio.load = _load


_patch_torchaudio_load()

from f5_tts.api import F5TTS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_REF = os.path.join(
    os.path.expanduser("~"), ".sovereign", "data", "voice", "references", "default.wav"
)
REF_AUDIO = os.environ.get("F5_TTS_REF_AUDIO", _DEFAULT_REF)
REF_TEXT = os.environ.get(
    "F5_TTS_REF_TEXT",
    "altitude record for fixed wing flight is 85,000 feet, sir. "
    "Sir, there is a potentially fatal buildup of ice occurring. "
    "A very astute observation, sir.",
)

print(f"torch {torch.__version__}, cuda available: {torch.cuda.is_available()}")
print(f"ref audio: {REF_AUDIO} exists={os.path.exists(REF_AUDIO)}")

t0 = time.time()
tts = F5TTS(device="cuda:0")
print(f"model load: {time.time() - t0:.1f}s")

t0 = time.time()
wav, sr, _ = tts.infer(
    ref_file=REF_AUDIO,
    ref_text=REF_TEXT,
    gen_text="Good evening. All systems report nominal.",
    seed=42,
)
dt = time.time() - t0
dur = len(wav) / sr
print(f"synth 1 (cold): {dt:.1f}s wall, {dur:.2f}s audio, RTF {dt / dur:.2f}x, sr={sr}")

out_path = os.path.join(BASE_DIR, "smoke_test_output.wav")
sf.write(out_path, wav, sr)
print(f"wrote {out_path}")

t0 = time.time()
wav2, sr2, _ = tts.infer(
    ref_file=REF_AUDIO,
    ref_text=REF_TEXT,
    gen_text="Good evening. All systems report nominal.",
    seed=42,
)
dt2 = time.time() - t0
dur2 = len(wav2) / sr2
print(f"synth 2 (warm, same text): {dt2:.1f}s wall, {dur2:.2f}s audio, RTF {dt2 / dur2:.2f}x")

# Determinism check — same seed should give byte-identical (or near-identical) output.
import numpy as np
same = np.allclose(wav, wav2)
print(f"deterministic across calls with fixed seed: {same}")

print("SMOKE TEST COMPLETE")
