# F5-TTS Voice Service

Persistent HTTP service for voice cloning via F5-TTS flow matching. Non-autoregressive — fixed ODE steps over a mel-spectrogram tensor, deterministic output for a given seed.

## Setup

Requires ROCm-compatible GPU (tested on Strix Halo iGPU, gfx1151).

```bash
# Create venv and install deps
python -m venv .venv
.venv/bin/pip install torch torchaudio --index-url https://download.pytorch.org/whl/nightly/rocm6.4
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install f5-tts uvicorn fastapi

# Place your voice reference clip
mkdir -p ~/.sovereign/data/voice/references
cp your-reference.wav ~/.sovereign/data/voice/references/default.wav

# Install and start
bash setup.sh
systemctl --user enable --now f5-tts.service
```

## Voice reference

The server clones from a reference audio clip at startup. Default path:

```
~/.sovereign/data/voice/references/default.wav
```

Override the clip path and its transcript via env vars:

```bash
F5_TTS_REF_AUDIO=/path/to/clip.wav
F5_TTS_REF_TEXT="transcript of the reference clip"
```

## Endpoints

| Method | Path                 | Purpose                              |
| ------ | -------------------- | ------------------------------------ |
| GET    | `/health`            | Readiness check, model info, uptime  |
| POST   | `/synthesize`        | Single-shot synthesis → WAV response |
| POST   | `/synthesize/stream` | Sentence-level streaming → NDJSON    |

## Config (env vars)

| Var                | Default                                          | Purpose                      |
| ------------------ | ------------------------------------------------ | ---------------------------- |
| `F5_TTS_HOST`      | `127.0.0.1`                                      | Bind address                 |
| `F5_TTS_PORT`      | `5812`                                           | Bind port                    |
| `F5_TTS_REF_AUDIO` | `~/.sovereign/data/voice/references/default.wav` | Voice reference clip         |
| `F5_TTS_REF_TEXT`  | _(built-in default)_                             | Transcript of reference clip |

## Logs

Systemd logs to `~/.sovereign/data/voice/f5-tts.{stdout,stderr}.log`.
