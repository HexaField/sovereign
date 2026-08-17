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
    ):
        self.server_url = server_url.rstrip("/")
        self.device_id = device_id
        self.model_path = model_path
        self.threshold = threshold
        self.silence_timeout = silence_timeout
        self.max_capture = max_capture
        self.input_device = input_device
        self._running = False
        self._ws = None

    async def run(self):
        """Main event loop."""
        self._running = True
        log.info("Voice node starting")
        log.info("  Server:    %s", self.server_url)
        log.info("  Device ID: %s", self.device_id)
        log.info("  Model:     %s", self.model_path)
        log.info("  Threshold: %.2f", self.threshold)

        # Start WebSocket listener for TTS playback in background
        ws_task = asyncio.create_task(self._ws_listener())

        # Run the wake word detection loop (blocking on audio)
        try:
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

        # Load wake word model
        oww = Model(wakeword_models=[self.model_path], inference_framework="onnx")
        model_names = list(oww.prediction_buffer.keys())
        log.info("Wake word models loaded: %s", model_names)

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
            async with aiohttp.ClientSession() as session:
                form = aiohttp.FormData()
                form.add_field(
                    "audio",
                    wav_data,
                    filename="capture.wav",
                    content_type="audio/wav",
                )
                form.add_field("deviceId", self.device_id)

                async with session.post(url, data=form, timeout=aiohttp.ClientTimeout(total=30)) as resp:
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
        import websockets

        ws_url = self.server_url.replace("http://", "ws://").replace("https://", "wss://")
        ws_url += "/ws"

        while self._running:
            try:
                log.info("Connecting WebSocket to %s", ws_url)
                async with websockets.connect(ws_url) as ws:
                    # Subscribe to voice channel
                    await ws.send(json.dumps({
                        "type": "subscribe",
                        "channels": ["voice"],
                        "deviceId": self.device_id,
                    }))
                    log.info("WebSocket connected — listening for TTS events")

                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            continue

                        if msg.get("type") == "tts.play":
                            # Check device routing
                            target = msg.get("deviceId")
                            if target and target != self.device_id:
                                continue
                            await self._play_audio(msg)

            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._running:
                    log.warning("WebSocket disconnected: %s — reconnecting in 5s", e)
                    await asyncio.sleep(5)

    async def _play_audio(self, msg: dict):
        """Play a TTS audio response through the speaker."""
        audio_b64 = msg.get("audio")
        if not audio_b64:
            return

        log.info("Playing TTS response (%.1f KB)", len(audio_b64) * 3 / 4 / 1024)

        try:
            wav_data = base64.b64decode(audio_b64)
            await asyncio.to_thread(self._play_wav, wav_data)
        except Exception as e:
            log.error("Playback failed: %s", e)

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
        default=30.0,
        help="Maximum capture duration in seconds (default: 30)",
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
    model_path = find_wake_model(args.model)

    node = VoiceNode(
        server_url=args.server,
        device_id=device_id,
        model_path=model_path,
        threshold=args.threshold,
        silence_timeout=args.silence_timeout,
        max_capture=args.max_capture,
        input_device=args.input_device,
    )
    asyncio.run(node.run())


if __name__ == "__main__":
    main()
