"""Qwen3-TTS voice service: the F5-TTS HTTP API in front of qwentts.cpp.

Sovereign's voice module speaks one API (POST /synthesize -> WAV,
POST /synthesize/stream -> NDJSON audio chunks, GET /health). This adapter
serves that API and forwards each request to qwentts.cpp's `tts-server`
(OpenAI-compatible, model kept loaded on the GPU through Vulkan), with one
cloned voice registered from a reference clip and its transcript.
"""

import array
import base64
import io
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
import wave

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


# (min, max) seconds per chunk: past max with no pause, cut at the quietest frame.
FIRST_CHUNK_S = (0.6, 2.0)  # the first chunk starts speech quickly
CHUNK_S = (2.0, 6.0)
_FRAME = SAMPLE_RATE // 50  # 20 ms
_QUIET_FRAMES = 5  # a pause is >= 100 ms below _QUIET_RMS
_QUIET_RMS = 300  # 16-bit RMS, about -40 dBFS


def _frame_rms(pcm: bytes) -> list[float]:
    s = array.array("h", pcm[: len(pcm) // 2 * 2])
    out = []
    for i in range(0, len(s) - _FRAME + 1, _FRAME):
        f = s[i : i + _FRAME]
        out.append((sum(x * x for x in f) / _FRAME) ** 0.5)
    return out


def _pause_cut(buf: bytes, limits: tuple[float, float]) -> int:
    """Byte offset to cut `buf` at: the middle of the first pause after the
    minimum, or the quietest frame once the maximum is reached; 0 = keep buffering."""
    min_s, max_s = limits
    n = len(buf) // 2 // _FRAME
    start = int(min_s * 50)
    if n <= start + _QUIET_FRAMES:
        return 0
    rms = _frame_rms(buf)
    run = 0
    for i in range(start, len(rms)):
        run = run + 1 if rms[i] < _QUIET_RMS else 0
        if run >= _QUIET_FRAMES:
            return (i - run // 2) * _FRAME * 2
    if n >= max_s * 50:
        i = min(range(start, len(rms)), key=lambda k: rms[k])
        return i * _FRAME * 2
    return 0


def _pcm_to_wav(pcm: bytes) -> bytes:
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return b.getvalue()


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
    """The whole text in ONE engine request, so the delivery stays continuous
    (one request per sentence let each sentence pick its own tone). The PCM
    stream is cut into NDJSON chunks at pauses: a short first chunk for a fast
    start, then about 2-6 s each."""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must contain at least one character")
    try:
        _ensure_voice()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"backend not ready: {e}")

    def open_stream():
        """The engine's PCM stream; re-registers the voice once if the engine restarted."""
        global _registered
        body = {"input": text, "voice": VOICE, "language": LANGUAGE, "response_format": "pcm", "seed": SEED}
        for attempt in (0, 1):
            _ensure_voice()
            req_ = urllib.request.Request(
                BACKEND + "/v1/audio/speech", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
            )
            try:
                return urllib.request.urlopen(req_, timeout=300)
            except urllib.error.HTTPError as e:
                if attempt == 0 and e.code in (400, 404):
                    _registered = False
                    continue
                raise

    def generate():
        t0 = time.time()
        idx = 0
        out = 0.0

        def emit(pcm: bytes, done: bool) -> str:
            nonlocal idx, out
            dur = len(pcm) / 2 / SAMPLE_RATE
            out += dur
            line = json.dumps({
                "index": idx,
                "total": idx + 1,
                "sentence": text,
                "audio": base64.b64encode(_pcm_to_wav(pcm)).decode("ascii"),
                "durationMs": round(dur * 1000),
                "rtf": round((time.time() - t0) / out, 3) if out else 0,
                "done": done,
            }) + "\n"
            idx += 1
            return line

        buf = bytearray()
        try:
            with open_stream() as r:
                while data := r.read(4800):
                    buf += data
                    cut = _pause_cut(buf, FIRST_CHUNK_S if idx == 0 else CHUNK_S)
                    if cut:
                        yield emit(bytes(buf[:cut]), False)
                        del buf[:cut]
        except Exception as exc:
            log.exception('stream synth failed: "%s..."', text[:40])
            yield json.dumps({"index": idx, "total": idx + 1, "sentence": text, "error": str(exc), "done": True}) + "\n"
            return
        yield emit(bytes(buf), True)
        dt = time.time() - t0
        log.info('stream "%s%s" -> %d chunks, %.1fs wall, %.1fs audio, RTF %.2fx', text[:40], "..." if len(text) > 40 else "", idx, dt, out, dt / out if out else 0)

    return StreamingResponse(generate(), media_type="application/x-ndjson")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
