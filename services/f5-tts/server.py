#!/usr/bin/env python3
"""F5-TTS persistent HTTP voice-clone service (ROCm iGPU).

Loads the F5-TTS base model once, then serves synthesis requests for the
lifetime of the process. F5-TTS uses flow matching (non-autoregressive): a
fixed number of ODE steps (nfe_step) runs over a mel-spectrogram tensor
sized to the target duration, and that duration follows a deterministic
character-count ratio against the reference clip — so, unlike autoregressive
sampling, request shape depends only on gen_text length, never on RNG
draws. A calibration warm-up at startup covers short/medium/long shapes so
real requests land on cached ROCm kernels rather than paying the cold JIT
compile cost (observed 3-4x slower on first touch of a new shape).

Run manually:
    PYTHONUNBUFFERED=1 HSA_USE_SVM=0 TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1 \
        MIOPEN_LOG_LEVEL=0 .venv/bin/python server.py

Or via the systemd unit in systemd/f5-tts.service.
"""
import base64
import io
import json
import logging
import os
import re
import threading
import time
from contextlib import asynccontextmanager

# Set these before the torch/f5_tts import so ROCm picks them up at init.
os.environ.setdefault("HSA_USE_SVM", "0")
os.environ.setdefault("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", "1")
os.environ.setdefault("MIOPEN_LOG_LEVEL", "0")

import numpy as np
import soundfile as sf
import torch
import torchaudio
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [f5-tts] %(message)s",
)
log = logging.getLogger("f5-tts")


def _patch_torchaudio_load() -> None:
    """Route torchaudio.load through soundfile instead of torchcodec.

    torchaudio 2.9 dispatches load() to torchcodec, which needs FFmpeg
    shared libraries this machine does not carry (a static ffmpeg binary
    sits on PATH, but no libavcodec.so — the dev libs need sudo, out of
    scope for this venv-only install). f5_tts calls torchaudio.load() at
    exactly one site, for the known-format reference WAV, so a soundfile
    loader covers that call without a new native dependency.
    """

    def _load(filepath, *args, **kwargs):
        data, sr = sf.read(filepath, dtype="float32", always_2d=True)
        wav = torch.from_numpy(np.ascontiguousarray(data.T))
        return wav, sr

    torchaudio.load = _load


_patch_torchaudio_load()

from f5_tts.api import F5TTS  # noqa: E402  (must follow the torchaudio patch)

# --- Config -----------------------------------------------------------------

MODEL_NAME = "F5TTS_v1_Base"
MODEL_ID = "SWivid/F5-TTS"  # reported on /health per the shared API contract
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Voice reference clip — the source audio that F5-TTS clones from.
# Defaults to the Sovereign data dir; override via env var for custom setups.
_DEFAULT_REF = os.path.join(
    os.path.expanduser("~"), ".sovereign", "data", "voice", "references", "default.wav"
)
REF_AUDIO = os.environ.get("F5_TTS_REF_AUDIO", _DEFAULT_REF)
# Transcript of the reference clip — must match the audio content closely.
# Override via F5_TTS_REF_TEXT env var when changing the reference clip.
REF_TEXT = os.environ.get(
    "F5_TTS_REF_TEXT",
    "altitude record for fixed wing flight is 85,000 feet, sir. "
    "Sir, there is a potentially fatal buildup of ice occurring. "
    "A very astute observation, sir.",
)
PORT = int(os.environ.get("F5_TTS_PORT", "5812"))
HOST = os.environ.get("F5_TTS_HOST", "127.0.0.1")
MAX_TEXT_CHARS = 2000

# Flow matching has no sampling temperature to switch off. seed_everything()
# runs on every infer() call inside f5_tts, so a fixed seed here gives the
# do_sample=False equivalent: same text in, same audio out, every time.
SEED = 42
NFE_STEP = 32  # ODE steps; f5_tts default, quality/speed lever if ever tuned

# Calibration texts of increasing length — populate the ROCm kernel cache
# across the range of mel-frame shapes real requests likely hit. Duration
# follows a deterministic character-count ratio against the reference
# clip, so nearby-length requests land on an already-warm shape.
CALIBRATION_LINES = [
    # ~4 words — very short ack
    "Good evening. All clear.",
    # ~11 words — typical ack length
    "Stand by. Checking the build logs for errors now.",
    # ~24 words — short summary
    "The analysis completed just now. Three items need attention, "
    "and none of them carry any urgency.",
    # ~40 words — medium summary
    "Shall I run a full diagnostic, or would a summary of the "
    "critical findings suit better before we proceed further with the "
    "parameters you set out earlier this morning?",
    # ~60 words — longer summary
    "The deployment finished across all four services. Build time "
    "landed at forty-two seconds with zero type errors. The voice "
    "pipeline now routes audio to the correct device, and the summary "
    "bubble refreshes after each assistant turn on the gateway thread. "
    "Three follow-up items remain for the next session.",
]


def _quiet_show_info(_msg: str) -> None:
    """Swallow f5_tts's print-based status callback; log.info covers it."""


class _QuietProgress:
    """Drop-in stand-in for the tqdm module f5_tts expects as `progress`.

    f5_tts calls `progress.tqdm(iterable)` (mirroring the real tqdm module's
    own `tqdm.tqdm` entry point), not `progress(iterable)` — a plain
    callable does not satisfy that shape. Swallowing the bar keeps the
    systemd journal free of carriage-return-redrawn progress lines.
    """

    @staticmethod
    def tqdm(iterable, *_args, **_kwargs):
        return iterable


# --- Model state --------------------------------------------------------------

class ModelState:
    def __init__(self):
        self.model: F5TTS | None = None
        self.ready = False
        self.lock = threading.Lock()
        self.started_at = time.time()


state = ModelState()


def _synthesize(model: F5TTS, text: str):
    """Run one flow-matching pass. Shared by warm-up and the request path."""
    wav, sr, _ = model.infer(
        ref_file=REF_AUDIO,
        ref_text=REF_TEXT,
        gen_text=text,
        seed=SEED,
        nfe_step=NFE_STEP,
        show_info=_quiet_show_info,
        progress=_QuietProgress,
    )
    return wav, sr


def _load_and_warm() -> None:
    log.info("Loading model %s (%s, device=cuda:0) ...", MODEL_ID, MODEL_NAME)
    t0 = time.time()
    model = F5TTS(model=MODEL_NAME, device="cuda:0")
    log.info("Model loaded in %.1fs", time.time() - t0)

    dtype = next(model.ema_model.parameters()).dtype
    log.info("DiT backbone dtype: %s", dtype)

    log.info(
        "Pre-warming ROCm kernel cache with %d calibration lines "
        "(short/medium/long) against the voice reference clip ...",
        len(CALIBRATION_LINES),
    )
    for i, line in enumerate(CALIBRATION_LINES, 1):
        t0 = time.time()
        wav, sr = _synthesize(model, line)
        dt = time.time() - t0
        dur = len(wav) / sr
        rtf = dt / dur if dur else float("inf")
        log.info(
            "  calibration [%d/%d] %.1fs wall, %.1fs audio, RTF %.2fx",
            i, len(CALIBRATION_LINES), dt, dur, rtf,
        )

    state.model = model
    state.ready = True
    log.info("F5-TTS voice service READY on %s:%d", HOST, PORT)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_and_warm()
    yield
    log.info("Shutting down F5-TTS service.")


app = FastAPI(title="F5-TTS voice service", lifespan=lifespan)


# --- Schemas ------------------------------------------------------------------

class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_TEXT_CHARS)


# --- Routes ---------------------------------------------------------------

@app.get("/health")
def health():
    if not state.ready:
        raise HTTPException(status_code=503, detail="model not ready")
    return {
        "status": "ok",
        "model": MODEL_ID,
        "uptime_s": round(time.time() - state.started_at, 1),
    }


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    if not state.ready or state.model is None:
        raise HTTPException(status_code=503, detail="model not ready")

    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must contain at least one character")

    try:
        # Serialize GPU access — the ODE solve and ROCm context do not
        # tolerate concurrent invocation from multiple request threads.
        with state.lock:
            t0 = time.time()
            wav, sr = _synthesize(state.model, text)
            dt = time.time() - t0
    except Exception:
        log.exception('synth failed for text="%s..."', text[:60])
        raise HTTPException(status_code=500, detail="synthesis failed")

    dur = len(wav) / sr
    rtf = dt / dur if dur else float("inf")
    log.info(
        'synth "%s%s" -> %.1fs wall, %.1fs audio, RTF %.2fx',
        text[:60], "..." if len(text) > 60 else "", dt, dur, rtf,
    )

    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)

    return Response(
        content=buf.read(),
        media_type="audio/wav",
        headers={
            "X-RTF": f"{rtf:.3f}",
            "X-Audio-Duration-Seconds": f"{dur:.3f}",
            "Content-Disposition": 'inline; filename="synthesis.wav"',
        },
    )


# --- Streaming helpers --------------------------------------------------------

_SENTENCE_RE = re.compile(r'(?<=[.!?])\s+')


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences at terminal punctuation boundaries."""
    parts = _SENTENCE_RE.split(text.strip())
    return [s.strip() for s in parts if s.strip()]


def _wav_bytes(wav_array, sr: int) -> bytes:
    """Encode a 1-D float numpy array as PCM-16 WAV bytes."""
    buf = io.BytesIO()
    sf.write(buf, wav_array, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return buf.read()


# --- Streaming route ----------------------------------------------------------

from starlette.responses import StreamingResponse  # noqa: E402


@app.post("/synthesize/stream")
def synthesize_stream(req: SynthesizeRequest):
    """Sentence-level streaming synthesis — NDJSON, one line per sentence."""
    if not state.ready or state.model is None:
        raise HTTPException(status_code=503, detail="model not ready")

    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must contain at least one character")

    sentences = _split_sentences(text)
    if not sentences:
        raise HTTPException(status_code=400, detail="no sentences found in text")

    def generate():
        total = len(sentences)
        for idx, sentence in enumerate(sentences):
            try:
                with state.lock:
                    t0 = time.time()
                    wav, sr = _synthesize(state.model, sentence)
                    dt = time.time() - t0

                dur = len(wav) / sr
                rtf = dt / dur if dur else float("inf")
                wav_b = _wav_bytes(wav, sr)
                audio_b64 = base64.b64encode(wav_b).decode("ascii")

                log.info(
                    'stream [%d/%d] "%s%s" -> %.1fs wall, %.1fs audio, RTF %.2fx',
                    idx + 1, total,
                    sentence[:40], "..." if len(sentence) > 40 else "",
                    dt, dur, rtf,
                )

                chunk = {
                    "index": idx,
                    "total": total,
                    "sentence": sentence,
                    "audio": audio_b64,
                    "durationMs": round(dur * 1000),
                    "rtf": round(rtf, 3),
                    "done": idx == total - 1,
                }
                yield json.dumps(chunk) + "\n"

            except Exception as exc:
                log.exception(
                    'stream synth failed at sentence %d: "%s..."', idx, sentence[:40]
                )
                error_chunk = {
                    "index": idx,
                    "total": total,
                    "sentence": sentence,
                    "error": str(exc),
                    "done": True,
                }
                yield json.dumps(error_chunk) + "\n"
                return

    return StreamingResponse(generate(), media_type="application/x-ndjson")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
