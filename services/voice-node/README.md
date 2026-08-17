# Sovereign Voice Node

Always-on wake word detection and audio pipe for Sovereign. Runs on Raspberry Pi, macOS, or any Linux box with a microphone.

Each Sovereign instance trains a wake word matching the configured assistant name — the voice node loads whichever model the user trained.

## How it works

1. **Listen** — OpenWakeWord runs the trained wake word model
2. **Capture** — Records speech after detection until silence
3. **Send** — POSTs the audio to Sovereign's `/api/voice/transcribe`
4. **Receive** — WebSocket connection receives TTS playback events
5. **Play** — Plays audio responses through the system speaker

## Quick start

```bash
# Install dependencies and set up the service
SOVEREIGN_URL=http://arcadia:5801 ./setup.sh

# Test audio devices
.venv/bin/python voice_node.py --list-devices

# Run manually
.venv/bin/python voice_node.py --server http://arcadia:5801

# Or start via systemd (Linux/Pi)
systemctl --user enable --now sovereign-voice-node

# Or start via launchd (macOS)
launchctl load ~/Library/LaunchAgents/com.sovereign.voice-node.plist
```

## Configuration

| Env var / flag                   | Default                 | Purpose                              |
| -------------------------------- | ----------------------- | ------------------------------------ |
| `--server` / `SOVEREIGN_URL`     | `http://localhost:5801` | Sovereign server URL                 |
| `--model` / `WAKE_MODEL`         | auto-detect             | Path to `.onnx` wake word model      |
| `--threshold` / `WAKE_THRESHOLD` | `0.5`                   | Detection confidence threshold (0-1) |
| `--silence-timeout`              | `1.5`                   | Seconds of silence to end capture    |
| `--max-capture`                  | `30`                    | Maximum capture duration (seconds)   |
| `--input-device`                 | system default          | PyAudio input device index           |

## Wake word model

The node searches for a trained model in this order:

1. `--model` argument or `WAKE_MODEL` env var
2. `~/.sovereign/data/voice/wake_word.onnx` (installed by `train.py`)
3. Any `.onnx` file in `services/wake-word/training_output/`
4. Falls back to bundled `hey_mycroft` for development

Train a custom wake word:

```bash
cd ../wake-word
# Edit the YAML to set your wake phrase, then:
.venv/bin/python train.py --config my_assistant.yaml
```

## Device ID

Each node generates a stable device ID on first run, stored at `~/.sovereign/data/voice/node-device-id`. This ID routes TTS playback to the correct physical speaker.

## Platform notes

**Raspberry Pi** — Install PortAudio first: `sudo apt install portaudio19-dev`. The systemd user service starts on login. For headless operation, enable lingering: `loginctl enable-linger $USER`.

**macOS** — Requires microphone permission. On first run, macOS prompts to grant Terminal (or the calling app) microphone access. PortAudio installs via Homebrew: `brew install portaudio`.

**Linux desktop** — Works out of the box with PulseAudio or PipeWire. PortAudio: `sudo apt install portaudio19-dev`.
