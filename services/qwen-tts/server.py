"""Qwen3-TTS voice service: the F5-TTS HTTP API in front of qwentts.cpp.

Sovereign's voice module speaks one API (POST /synthesize -> WAV,
POST /synthesize/stream -> NDJSON per sentence, GET /health). This adapter
serves that API and forwards each request to qwentts.cpp's `tts-server`
(OpenAI-compatible, model kept loaded on the GPU through Vulkan), with one
cloned voice registered from a reference clip and its transcript.
"""

import base64
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("qwen-tts")

BACKEND = os.environ.get("QWEN_TTS_BACKEND_URL", "http://127.0.0.1:5814").rstrip("/")
REF_AUDIO = os.environ.get(
    "QWEN_TTS_REF_AUDIO", os.path.expanduser("~/.sovereign/data/voice/references/default.wav")
)
# Transcript of the reference clip; in-context cloning needs it to match the audio.
REF_TEXT = os.environ.get("QWEN_TTS_REF_TEXT", "")
VOICE = os.environ.get("QWEN_TTS_VOICE", "default")
LANGUAGE = os.environ.get("QWEN_TTS_LANGUAGE", "English")
SEED = int(os.environ.get("QWEN_TTS_SEED", "42"))
HOST = os.environ.get("QWEN_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("QWEN_TTS_PORT", "5813"))
MAX_TEXT_CHARS = 2000
SAMPLE_RATE = 24000

app = FastAPI(title="qwen-tts")
_registered = False
_register_lock = threading.Lock()
_started_at = time.time()

_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_TEXT_CHARS)


def _post(path: str, body: dict, timeout: float = 120) -> bytes:
    req = urllib.request.Request(
        BACKEND + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _ensure_voice() -> None:
    """Register the cloned voice once per tts-server process."""
    global _registered
    with _register_lock:
        if _registered:
            return
        with open(REF_AUDIO, "rb") as f:
            wav_b64 = base64.b64encode(f.read()).decode("ascii")
        _post("/v1/audio/voices", {"name": VOICE, "ref_text": REF_TEXT, "wav_b64": wav_b64})
        _registered = True
        log.info("registered voice '%s' from %s (ref_text=%s)", VOICE, REF_AUDIO, "yes" if REF_TEXT else "no")


def _synthesize(text: str) -> bytes:
    """One WAV for `text`. Re-registers the voice once if tts-server restarted."""
    global _registered
    body = {"input": text, "voice": VOICE, "language": LANGUAGE, "response_format": "wav", "seed": SEED}
    for attempt in (0, 1):
        _ensure_voice()
        try:
            return _post("/v1/audio/speech", body)
        except urllib.error.HTTPError as e:
            if attempt == 0 and e.code in (400, 404):
                _registered = False
                continue
            raise


def _wav_seconds(wav: bytes) -> float:
    # tts-server writes a canonical 44-byte header, 16-bit mono.
    return max(len(wav) - 44, 0) / 2 / SAMPLE_RATE


def _split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_RE.split(text.strip()) if s.strip()]


@app.get("/health")
def health():
    try:
        _ensure_voice()
    except Exception as e:  # tts-server down or reference unreadable
        raise HTTPException(status_code=503, detail=f"backend not ready: {e}")
    return {"status": "ok", "model": "Qwen3-TTS-1.7B (qwentts.cpp)", "voice": VOICE,
            "uptime_s": round(time.time() - _started_at, 1)}


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    text = req.text.strip()
    t0 = time.time()
    try:
        wav = _synthesize(text)
    except Exception:
        log.exception('synth failed for text="%s..."', text[:60])
        raise HTTPException(status_code=500, detail="synthesis failed")
    dt, dur = time.time() - t0, _wav_seconds(wav)
    rtf = dt / dur if dur else float("inf")
    log.info('synth "%s%s" -> %.1fs wall, %.1fs audio, RTF %.2fx', text[:60], "..." if len(text) > 60 else "", dt, dur, rtf)
    return Response(content=wav, media_type="audio/wav", headers={"X-RTF": f"{rtf:.3f}"})


@app.post("/synthesize/stream")
def synthesize_stream(req: SynthesizeRequest):
    """Sentence-level streaming — NDJSON, one line per sentence."""
    sentences = _split_sentences(req.text)
    if not sentences:
        raise HTTPException(status_code=400, detail="no sentences found in text")

    def generate():
        total = len(sentences)
        for idx, sentence in enumerate(sentences):
            t0 = time.time()
            try:
                wav = _synthesize(sentence)
            except Exception as exc:
                log.exception('stream synth failed at sentence %d: "%s..."', idx, sentence[:40])
                yield json.dumps({"index": idx, "total": total, "sentence": sentence, "error": str(exc), "done": True}) + "\n"
                return
            dt, dur = time.time() - t0, _wav_seconds(wav)
            rtf = dt / dur if dur else float("inf")
            log.info('stream [%d/%d] "%s" -> %.1fs wall, %.1fs audio, RTF %.2fx', idx + 1, total, sentence[:40], dt, dur, rtf)
            yield json.dumps({
                "index": idx,
                "total": total,
                "sentence": sentence,
                "audio": base64.b64encode(wav).decode("ascii"),
                "durationMs": round(dur * 1000),
                "rtf": round(rtf, 3),
                "done": idx == total - 1,
            }) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
