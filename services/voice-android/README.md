# Sovereign Voice — Android

Lightweight Android companion app for always-on wake word detection. Runs as a foreground service with ONNX Runtime inference — minimal battery impact since the model processes small 80ms audio frames.

## How it works

1. Foreground service captures mic audio continuously
2. WakeWordDetector runs the ONNX model on each 80ms frame
3. On detection, records speech until silence (VAD)
4. POSTs WAV audio to Sovereign's `/api/voice/transcribe`
5. WebSocket connection receives TTS playback events
6. Plays audio responses through the phone speaker

## Setup

1. Copy the wake word model to `app/src/main/assets/hey_hex.onnx` (or use the default `hey_mycroft` fallback for testing)

2. Build with Android Studio or Gradle:

   ```bash
   ./gradlew assembleDebug
   ```

3. Install on device:

   ```bash
   adb install app/build/outputs/apk/debug/app-debug.apk
   ```

4. Launch the app, enter the Sovereign server URL, tap Start

## Permissions

- **Microphone** — continuous audio capture for wake word detection
- **Notifications** — foreground service notification (required by Android)
- **Internet** — communication with Sovereign server

## Requirements

- Android 8.0 (API 26) or higher
- Network access to the Sovereign server (same LAN or Tailscale)

## Battery

The ONNX model processes ~12 frames/second of 80ms audio. On modern phones this draws negligible CPU. The foreground service notification indicates the app runs in the background.
