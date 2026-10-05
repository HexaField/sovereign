#!/usr/bin/env python3
"""Sovereign voice node — always-on wake word detection + audio pipe.

Runs on Raspberry Pi, macOS, or any Linux box with a microphone.
Listens for the configured wake word, captures speech after detection,
sends it to Sovereign for transcription, and plays back TTS responses
from Sovereign via WebSocket.

The wake phrase depends on which model the user trained. Each Sovereign
instance trains its own wake word matching the assistant name.

Architecture:
    Mic → OpenWakeWord (wake detect) → VAD capture → POST /api/voice/transcribe
    WS ← tts.play events (filtered by deviceId) → speaker playback

Usage:
    .venv/bin/python voice_node.py --server http://arcadia:5801
"""
import argparse
import asyncio
import base64
import io
import json
import logging
import os
import platform
import struct
import sys
import time
import uuid
import wave
from pathlib import Path

import aiohttp
import numpy as np

from tts_queue import SpeechQueue

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [voice-node] %(message)s",
)
log = logging.getLogger("voice-node")

# Audio constants
SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK_SAMPLES = 1280  # 80ms frames (OpenWakeWord expects this)
FORMAT_WIDTH = 2  # 16-bit PCM

# Push-to-talk sends long speech in segments of this length (keys still held).
PTT_SEGMENT_S = 120.0


def _cue_wav() -> bytes:
    """Two short rising tones (660 Hz, 880 Hz): one reply ends, another follows."""
    rate = 24000
    t = np.arange(int(rate * 0.09)) / rate
    fade = np.minimum(1, np.minimum(t, t[::-1]) / 0.01)
    gap = np.zeros(int(rate * 0.02))
    tail = np.zeros(int(rate * 0.25))
    tones = [0.25 * np.sin(2 * np.pi * f * t) * fade for f in (660, 880)]
    pcm = (np.concatenate([tones[0], gap, tones[1], tail]) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


CUE_WAV = _cue_wav()

# Device ID — persisted across restarts
DEVICE_ID_FILE = Path.home() / ".sovereign" / "data" / "voice" / "node-device-id"


def get_or_create_device_id() -> str:
    """Return a stable device ID, creating one on first run."""
    DEVICE_ID_FILE.parent.mkdir(parents=True, exist_ok=True)
    if DEVICE_ID_FILE.exists():
        return DEVICE_ID_FILE.read_text().strip()
    device_id = f"voice-node-{platform.node()}-{uuid.uuid4().hex[:8]}"
    DEVICE_ID_FILE.write_text(device_id)
    log.info("Generated device ID: %s", device_id)
    return device_id


def find_wake_model(model_path: str | None) -> str:
    """Resolve the wake word model path.

    Search order:
      1. Explicit --model argument or WAKE_MODEL env var
      2. ~/.sovereign/data/voice/wake_word.onnx (installed by train.py)
      3. Any .onnx file in the wake-word training output directory
      4. Bundled 'hey_mycroft' fallback for development
    """
    if model_path and os.path.exists(model_path):
        return model_path

    # Standard installed location (train.py --step install writes here)
    installed = Path.home() / ".sovereign" / "data" / "voice" / "wake_word.onnx"
    if installed.exists():
        return str(installed)

    # Check training output for any trained model
    training_dir = Path(__file__).parent.parent / "wake-word" / "training_output"
    if training_dir.exists():
        onnx_files = list(training_dir.glob("*.onnx"))
        if onnx_files:
            chosen = onnx_files[0]
            log.info("Using trained model from build output: %s", chosen.name)
            return str(chosen)

    # Download a pre-trained fallback model for development
    log.warning(
        "No custom wake word model found — downloading 'hey_jarvis' pre-trained model. "
        "Train a custom model via: services/wake-word/train.py --config <your_config>.yaml"
    )
    fallback = Path.home() / ".sovereign" / "data" / "voice" / "wake_word.onnx"
    fallback.parent.mkdir(parents=True, exist_ok=True)
    if not fallback.exists():
        # Use openwakeword's built-in downloader (models hosted on GitHub Releases)
        try:
            from openwakeword.utils import download_models

            model_dir = str(fallback.parent)
            log.info("Downloading pre-trained models via openwakeword to %s", model_dir)
            download_models(model_names=["hey_jarvis"], target_directory=model_dir)

            # The downloader saves as hey_jarvis_v0.1.onnx — symlink to generic name
            downloaded = fallback.parent / "hey_jarvis_v0.1.onnx"
            if downloaded.exists() and not fallback.exists():
                import shutil

                shutil.copy2(str(downloaded), str(fallback))
                log.info("Fallback model ready at %s", fallback)
            elif not downloaded.exists():
                raise FileNotFoundError(f"Expected {downloaded} after download")
        except Exception as e:
            log.error("openwakeword download failed: %s — trying direct URL", e)
            # Direct fallback from GitHub Releases
            import urllib.request

            url = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/hey_jarvis_v0.1.onnx"
            log.info("Downloading from %s", url)
            try:
                urllib.request.urlretrieve(url, str(fallback))
                log.info("Fallback model saved to %s", fallback)
            except Exception as e2:
                log.error("Direct download also failed: %s", e2)
                log.error(
                    "No wake word model available. Supply one via --model "
                    "or train a custom model."
                )
                sys.exit(1)
    return str(fallback)


def ensure_preprocessor_models():
    """Download openwakeword's required preprocessor models if missing.

    openwakeword v0.6+ no longer bundles melspectrogram.onnx and the
    embedding model. They must exist in the package's resources/models
    directory before any Model() can load.

    Calls download_models with a dummy name so that only the feature
    extraction and VAD models get fetched (those always download),
    without pulling every wake word model.
    """
    try:
        import openwakeword

        models_dir = Path(openwakeword.__file__).parent / "resources" / "models"
        melspec = models_dir / "melspectrogram.onnx"

        if melspec.exists():
            return  # Already present

        log.info("Downloading openwakeword preprocessor models (first run)...")
        from openwakeword.utils import download_models

        # Pass a single model name — the function always fetches feature +
        # VAD models regardless, so we avoid downloading all wake words.
        download_models(
            model_names=["hey_jarvis"],
            target_directory=str(models_dir),
        )
        log.info("Preprocessor models ready in %s", models_dir)
    except Exception as e:
        log.error("Failed to download preprocessor models: %s", e)
        raise


class VoiceNode:
    """Main voice node — wake word detection, capture, and playback."""

    def __init__(
        self,
        server_url: str,
        device_id: str,
        model_path: str,
        threshold: float = 0.5,
        silence_timeout: float = 1.5,
        max_capture: float = 30.0,
        input_device: int | None = None,
        push_to_talk: bool = False,
        hotkey=None,
        device_name: str | None = None,
    ):
        self.server_url = server_url.rstrip("/")
        self.device_id = device_id
        self.device_name = device_name or platform.node()
        self.model_path = model_path
        self.threshold = threshold
        self.silence_timeout = silence_timeout
        self.max_capture = max_capture
        self.input_device = input_device
        self.push_to_talk = push_to_talk
        self.hotkey = hotkey
        self._running = False
        # Push-to-talk streams over the WebSocket while it stays connected and
        # the server offers voice-stream; otherwise it uploads on release.
        self._ws_ready = False
        self._can_stream = True
        # Counts connections: a stream started on one connection dies with it.
        self._ws_gen = 0
        # Messages for the WebSocket, sent in order by one task.
        self._outbox: asyncio.Queue = asyncio.Queue()
        # One POST at a time: segments of one long PTT message arrive in order.
        self._send_lock = asyncio.Lock()
        self._speech = SpeechQueue(self._play_clip, self._play_cue)
        # Fallback reply ids (thread + kind) for a server that sends no utterance id.
        self._fallback_ids: dict[str, str] = {}

    async def run(self):
        """Main event loop."""
        self._running = True
        log.info("Voice node starting")
        log.info("  Server:      %s", self.server_url)
        log.info("  Device ID:   %s", self.device_id)
        log.info("  Device name: %s", self.device_name)
        log.info("  Model:       %s", self.model_path)
        log.info("  Threshold:   %.2f", self.threshold)

        # Start WebSocket listener for TTS playback in background
        ws_task = asyncio.create_task(self._ws_listener())

        # Run the appropriate activation loop (both block in a thread)
        try:
            if self.push_to_talk:
                await asyncio.to_thread(self._ptt_loop, asyncio.get_event_loop())
            else:
                await asyncio.to_thread(self._detection_loop)
        except KeyboardInterrupt:
            log.info("Shutting down...")
        finally:
            self._running = False
            ws_task.cancel()
            try:
                await ws_task
            except asyncio.CancelledError:
                pass

    def _detection_loop(self):
        """Synchronous loop: listen for wake word, capture, send."""
        import pyaudio
        from openwakeword.model import Model

        # Ensure preprocessor models exist (melspectrogram + embedding)
        ensure_preprocessor_models()

        # Load wake word model
        oww = Model(wakeword_models=[self.model_path], inference_framework="onnx")

        # Model names register in oww.models at construction time.
        # prediction_buffer only populates after the first predict() call.
        model_names = list(oww.models.keys())
        log.info("Wake word models loaded: %s", model_names)

        if not model_names:
            log.error("No wake word models registered — check model file.")
            return

        pa = pyaudio.PyAudio()
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=CHANNELS,
            rate=SAMPLE_RATE,
            input=True,
            frames_per_buffer=CHUNK_SAMPLES,
            input_device_index=self.input_device,
        )
        log.info("Microphone stream open — listening for wake word...")

        try:
            while self._running:
                audio_bytes = stream.read(CHUNK_SAMPLES, exception_on_overflow=False)
                audio_np = np.frombuffer(audio_bytes, dtype=np.int16)

                # Feed to wake word model
                oww.predict(audio_np)

                # Check all model scores
                for name in model_names:
                    score = oww.prediction_buffer[name][-1]
                    if score >= self.threshold:
                        log.info("Wake word detected! (model=%s, score=%.3f)", name, score)
                        oww.reset()  # Clear buffer to avoid re-trigger

                        # Capture speech after wake word
                        captured = self._capture_speech(stream)
                        if captured:
                            # Send to Sovereign in a new thread
                            asyncio.run_coroutine_threadsafe(
                                self._send_audio(captured),
                                asyncio.get_event_loop(),
                            )
        finally:
            stream.stop_stream()
            stream.close()
            pa.terminate()

    @staticmethod
    def _parse_hotkey(key_str: str):
        """Parse a hotkey string into a list of pynput Key objects.

        Supports single keys and combos joined with '+':
            right_cmd          → [Key.cmd_r]
            left_cmd+right_cmd → [Key.cmd_l, Key.cmd_r]
            ctrl+left_alt+left_cmd → [Key.ctrl, Key.alt_l, Key.cmd_l]

        Key names: right_cmd, left_cmd, cmd, right_alt, left_alt, alt,
        right_ctrl, left_ctrl, ctrl, f1–f20.
        """
        import pynput.keyboard

        key_map = {
            "right_cmd": pynput.keyboard.Key.cmd_r,
            "left_cmd": pynput.keyboard.Key.cmd_l,
            "cmd": pynput.keyboard.Key.cmd,
            "right_alt": pynput.keyboard.Key.alt_r,
            "left_alt": pynput.keyboard.Key.alt_l,
            "alt": pynput.keyboard.Key.alt,
            "right_ctrl": pynput.keyboard.Key.ctrl_r,
            "left_ctrl": pynput.keyboard.Key.ctrl_l,
            "ctrl": pynput.keyboard.Key.ctrl,
        }

        parts = [p.lower().strip() for p in key_str.split("+")]
        result = []
        for part in parts:
            if part in key_map:
                result.append(key_map[part])
            elif part.startswith("f") and part[1:].isdigit():
                num = int(part[1:])
                if 1 <= num <= 20:
                    result.append(getattr(pynput.keyboard.Key, f"f{num}"))
                else:
                    raise ValueError(f"Unsupported function key: {part}")
            else:
                raise ValueError(f"Unsupported hotkey component: {part}")

        if not result:
            raise ValueError(f"Empty hotkey: {key_str}")
        return result

    def _ptt_loop(self, loop):
        """Push-to-talk loop: hold hotkey combo to record, release to send.

        Runs in a worker thread via asyncio.to_thread. The `loop` argument
        holds the asyncio event loop for scheduling async sends.

        With the WebSocket up, audio streams as voice-stream chunks while
        the keys stay held: the server shows the live text as a draft in the
        presence thread and sends the message there on release. Without
        it, the node uploads the recording on release (in segments of
        max_capture seconds).

        Supports single keys and combos. For combos, all keys must stay
        held to keep recording. Releasing any combo key stops capture.
        """
        import pyaudio
        import pynput.keyboard

        target_keys = set(self._parse_hotkey(self.hotkey))
        log.info("Push-to-talk mode — hold [%s] to speak", self.hotkey)

        pa = pyaudio.PyAudio()
        recording = False
        frames = []
        held_keys = set()  # Track which combo keys stay held

        def _on_press(k):
            nonlocal recording, frames
            if k in target_keys:
                held_keys.add(k)
                # Start recording when all combo keys appear held
                if held_keys >= target_keys and not recording:
                    recording = True
                    frames = []
                    log.info("Recording...")

        def _on_release(k):
            nonlocal recording
            if k in target_keys:
                held_keys.discard(k)
                # Stop recording when any combo key lifts
                if recording:
                    recording = False

        listener = pynput.keyboard.Listener(
            on_press=_on_press,
            on_release=_on_release,
        )
        listener.start()

        try:
            while self._running:
                if recording:
                    gen = self._ws_gen
                    streaming = self._stream_alive(gen)
                    if streaming:
                        self._ws_send(loop, {
                            "type": "voice-stream.start",
                            "format": "pcm16",
                            "sampleRate": SAMPLE_RATE,
                            "deliver": "presence",
                        })
                    # Open mic only while key held — no orange dot otherwise
                    try:
                        stream = pa.open(
                            format=pyaudio.paInt16,
                            channels=CHANNELS,
                            rate=SAMPLE_RATE,
                            input=True,
                            frames_per_buffer=CHUNK_SAMPLES,
                            input_device_index=self.input_device,
                        )
                        while recording and self._running:
                            audio_bytes = stream.read(
                                CHUNK_SAMPLES, exception_on_overflow=False
                            )
                            # Kept while streaming too: if the stream breaks mid-hold
                            # (connection lost, server without voice-stream), the
                            # whole recording uploads on release instead.
                            frames.append(audio_bytes)
                            if streaming and not self._stream_alive(gen):
                                log.warning("Push-to-talk stream lost — uploading on release")
                                streaming = False
                            if streaming:
                                self._ws_send(loop, {
                                    "type": "voice-stream.chunk",
                                    "audio": base64.b64encode(audio_bytes).decode(),
                                })
                                continue
                            # Long speech: send this segment and keep recording,
                            # so transcription stays inside the server timeout
                            # and nothing said while the keys stay held gets lost.
                            if len(frames) * CHUNK_SAMPLES / SAMPLE_RATE >= self.max_capture:
                                segment, frames = frames, []
                                self._send_frames(segment, loop)
                        stream.stop_stream()
                        stream.close()
                    except Exception as e:
                        log.error("Mic error during PTT capture: %s", e)
                        recording = False

                    # Key released — send what remains
                    if streaming:
                        self._ws_send(loop, {"type": "voice-stream.stop"})
                        log.info("Push-to-talk stream ended")
                        frames = []
                    elif frames:
                        segment, frames = frames, []
                        self._send_frames(segment, loop)
                else:
                    time.sleep(0.05)
        finally:
            listener.stop()
            listener.join()
            pa.terminate()

    def _stream_alive(self, gen: int) -> bool:
        """True while connection `gen` stays up and the server takes voice-stream."""
        return self._ws_ready and self._can_stream and self._ws_gen == gen

    def _ws_send(self, loop, msg: dict):
        """Queue a WebSocket message from the PTT thread; one task sends them in order."""
        loop.call_soon_threadsafe(self._outbox.put_nowait, msg)

    async def _send_outbox(self, ws):
        while True:
            await ws.send(json.dumps(await self._outbox.get()))

    def _send_frames(self, frames: list, loop):
        """Encode PTT frames and queue them for transcription (from the PTT thread)."""
        captured = self._encode_and_capture(frames)
        if not captured:
            return
        log.info(
            "Captured %.1fs (%.1f KB) — sending",
            len(frames) * CHUNK_SAMPLES / SAMPLE_RATE,
            len(captured) / 1024,
        )
        asyncio.run_coroutine_threadsafe(self._send_audio(captured), loop)

    def _encode_and_capture(self, frames: list) -> bytes | None:
        """Encode collected frames as WAV bytes (standalone, no stream needed)."""
        if not frames:
            return None

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(FORMAT_WIDTH)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(b"".join(frames))
        return buf.getvalue()

    def _capture_speech(self, stream) -> bytes | None:
        """Record audio after wake word until silence or max duration."""
        log.info("Capturing speech...")
        frames = []
        silence_start = None
        capture_start = time.time()

        while self._running:
            elapsed = time.time() - capture_start
            if elapsed >= self.max_capture:
                log.info("Max capture duration reached (%.1fs)", self.max_capture)
                break

            audio_bytes = stream.read(CHUNK_SAMPLES, exception_on_overflow=False)
            frames.append(audio_bytes)

            # Simple energy-based VAD
            audio_np = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32)
            rms = np.sqrt(np.mean(audio_np**2))

            if rms < 300:  # Silence threshold
                if silence_start is None:
                    silence_start = time.time()
                elif time.time() - silence_start >= self.silence_timeout:
                    log.info(
                        "Silence detected after %.1fs — capture complete (%.1fs total)",
                        self.silence_timeout,
                        elapsed,
                    )
                    break
            else:
                silence_start = None

        if not frames:
            return None

        # Encode as WAV
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(FORMAT_WIDTH)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(b"".join(frames))
        return buf.getvalue()

    async def _send_audio(self, wav_data: bytes):
        """POST captured audio to Sovereign for transcription."""
        url = f"{self.server_url}/api/voice/transcribe"
        log.info("Sending %.1f KB audio to %s", len(wav_data) / 1024, url)

        try:
            # Disable TLS verification for Tailscale Serve's internal certs
            async with self._send_lock, aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(ssl=False)
            ) as session:
                form = aiohttp.FormData()
                form.add_field(
                    "audio",
                    wav_data,
                    filename="capture.wav",
                    content_type="audio/wav",
                )
                form.add_field("deviceId", self.device_id)
                form.add_field("deviceName", self.device_name)

                # Whisper runs at about 0.2x real time: a 120 s segment takes ~25 s.
                # The server allows 120 s; wait a little longer than that.
                async with session.post(url, data=form, timeout=aiohttp.ClientTimeout(total=150)) as resp:
                    if resp.status == 200:
                        result = await resp.json()
                        log.info("Transcription: %s", result.get("text", "(empty)"))
                    else:
                        body = await resp.text()
                        log.warning("Transcription failed: %d %s", resp.status, body[:200])
        except Exception as e:
            log.error("Send failed: %s", e)

    async def _ws_listener(self):
        """Maintain a WebSocket connection for TTS playback events."""
        import ssl
        import websockets

        ws_url = self.server_url.replace("http://", "ws://").replace("https://", "wss://")
        ws_url += "/ws"

        # Disable TLS verification for Tailscale Serve's internal certs
        ssl_ctx = None
        if ws_url.startswith("wss://"):
            ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE

        while self._running:
            try:
                log.info("Connecting WebSocket to %s", ws_url)
                async with websockets.connect(ws_url, ssl=ssl_ctx) as ws:
                    # Announce device name — TTS routes by name (same protocol
                    # as Android/web clients). "client" makes this node the
                    # speaker over browser tabs that share the name.
                    await ws.send(json.dumps({
                        "type": "ws.device-name",
                        "deviceName": self.device_name,
                        "deviceId": self.device_id,
                        "client": "voice-node",
                    }))
                    log.info("WebSocket connected — announced as '%s', listening for TTS events", self.device_name)
                    # Push-to-talk streams on this channel; drop what a dead connection left.
                    await ws.send(json.dumps({"type": "subscribe", "channels": ["voice-stream"]}))
                    while not self._outbox.empty():
                        self._outbox.get_nowait()
                    self._can_stream = True
                    self._ws_gen += 1
                    self._ws_ready = True
                    sender = asyncio.create_task(self._send_outbox(ws))
                    try:
                        async for raw in ws:
                            try:
                                msg = json.loads(raw)
                            except json.JSONDecodeError:
                                continue

                            msg_type = msg.get("type")
                            # voice.tts.audio — from the voice-response pipeline
                            # (ack and summary TTS, routed by sendToDeviceName)
                            if msg_type == "voice.tts.audio":
                                self._play_audio(msg)
                            # Legacy tts.play — kept for backward compat
                            elif msg_type == "tts.play":
                                target = msg.get("deviceId")
                                if target and target != self.device_id:
                                    continue
                                self._play_audio(msg)
                            elif msg_type == "voice-stream.transcript" and msg.get("final"):
                                log.info("Transcription: %s", msg.get("text") or "(empty)")
                            elif msg_type == "voice-stream.error":
                                log.warning("Streaming STT error: %s", msg.get("message"))
                            # A server without streaming STT: upload on release instead.
                            elif msg_type == "error" and msg.get("code") in ("UNKNOWN_CHANNEL", "UNKNOWN_TYPE"):
                                log.warning("Server has no voice-stream (%s) — push-to-talk will upload", msg.get("message"))
                                self._can_stream = False
                    finally:
                        self._ws_ready = False
                        sender.cancel()

            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._running:
                    log.warning("WebSocket disconnected: %s — reconnecting in 5s", e)
                    await asyncio.sleep(5)

    def _play_audio(self, msg: dict):
        """Queue a TTS clip: whole replies play in arrival order, never cut off."""
        audio_b64 = msg.get("audio")
        if not audio_b64:
            return
        try:
            wav_data = base64.b64decode(audio_b64)
        except Exception as e:
            log.error("Bad TTS audio: %s", e)
            return
        chunk = msg.get("chunk") or None
        self._speech.enqueue(
            self._utterance_of(msg, chunk),
            wav_data,
            last=chunk is None or bool(chunk.get("done")),
            priority=msg.get("kind") == "ack",
        )

    def _utterance_of(self, msg: dict, chunk: dict | None) -> str:
        if msg.get("utterance"):
            return msg["utterance"]
        key = f"{msg.get('threadId')}:{msg.get('kind')}"
        if chunk is None or chunk.get("index") == 0 or key not in self._fallback_ids:
            self._fallback_ids[key] = f"{key}:{time.monotonic()}"
        return self._fallback_ids[key]

    async def _play_clip(self, wav_data: bytes):
        log.info("Playing TTS clip (%.1f KB)", len(wav_data) / 1024)
        try:
            await asyncio.to_thread(self._play_wav, wav_data)
        except Exception as e:
            log.error("Playback failed: %s", e)

    async def _play_cue(self):
        """Two short rising tones between back-to-back replies."""
        try:
            await asyncio.to_thread(self._play_wav, CUE_WAV)
        except Exception as e:
            log.error("Cue playback failed: %s", e)

    @staticmethod
    def _play_wav(wav_data: bytes):
        """Synchronous WAV playback via PyAudio."""
        import pyaudio

        buf = io.BytesIO(wav_data)
        with wave.open(buf, "rb") as wf:
            pa = pyaudio.PyAudio()
            stream = pa.open(
                format=pa.get_format_from_width(wf.getsampwidth()),
                channels=wf.getnchannels(),
                rate=wf.getframerate(),
                output=True,
            )
            chunk = 4096
            data = wf.readframes(chunk)
            while data:
                stream.write(data)
                data = wf.readframes(chunk)
            stream.stop_stream()
            stream.close()
            pa.terminate()


def main():
    parser = argparse.ArgumentParser(
        description="Sovereign voice node — wake word detection + audio pipe"
    )
    parser.add_argument(
        "--server",
        default=os.environ.get("SOVEREIGN_URL", "http://localhost:5801"),
        help="Sovereign server URL (default: $SOVEREIGN_URL or http://localhost:5801)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("WAKE_MODEL"),
        help="Path to wake word .onnx model (default: auto-detect)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=float(os.environ.get("WAKE_THRESHOLD", "0.5")),
        help="Wake word detection threshold 0-1 (default: 0.5)",
    )
    parser.add_argument(
        "--silence-timeout",
        type=float,
        default=1.5,
        help="Seconds of silence before ending capture (default: 1.5)",
    )
    parser.add_argument(
        "--max-capture",
        type=float,
        default=None,
        help=f"Wake word: maximum capture in seconds (default: 30). Push-to-talk: "
        f"segment length in seconds, recording continues while held (default: {PTT_SEGMENT_S:.0f})",
    )
    parser.add_argument(
        "--input-device",
        type=int,
        default=None,
        help="PyAudio input device index (default: system default)",
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="List available audio input devices and exit",
    )
    parser.add_argument(
        "--push-to-talk",
        action="store_true",
        help="Push-to-talk mode: hold hotkey to record instead of wake word detection",
    )
    parser.add_argument(
        "--hotkey",
        default="right_cmd",
        help="PTT hotkey name (default: right_cmd). Supports: right_cmd, left_cmd, right_alt, left_alt, right_ctrl, left_ctrl, f1–f20",
    )
    parser.add_argument(
        "--device-name",
        default=os.environ.get("DEVICE_NAME", platform.node()),
        help="Friendly device name for TTS routing (default: $DEVICE_NAME or hostname)",
    )
    args = parser.parse_args()

    if args.list_devices:
        import pyaudio

        pa = pyaudio.PyAudio()
        print("Available audio input devices:")
        for i in range(pa.get_device_count()):
            info = pa.get_device_info_by_index(i)
            if info["maxInputChannels"] > 0:
                print(f"  [{i}] {info['name']} (channels={info['maxInputChannels']}, rate={int(info['defaultSampleRate'])})")
        pa.terminate()
        return

    device_id = get_or_create_device_id()

    if args.push_to_talk:
        # PTT mode — no wake word model needed
        node = VoiceNode(
            server_url=args.server,
            device_id=device_id,
            model_path="",
            threshold=args.threshold,
            silence_timeout=args.silence_timeout,
            max_capture=args.max_capture or PTT_SEGMENT_S,
            input_device=args.input_device,
            push_to_talk=True,
            hotkey=args.hotkey,
            device_name=args.device_name,
        )
    else:
        model_path = find_wake_model(args.model)
        node = VoiceNode(
            server_url=args.server,
            device_id=device_id,
            model_path=model_path,
            threshold=args.threshold,
            silence_timeout=args.silence_timeout,
            max_capture=args.max_capture or 30.0,
            input_device=args.input_device,
            push_to_talk=False,
            device_name=args.device_name,
        )
    asyncio.run(node.run())


if __name__ == "__main__":
    main()
