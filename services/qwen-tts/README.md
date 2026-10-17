# Qwen3-TTS voice service

Serves Sovereign's TTS API (`POST /synthesize`, `POST /synthesize/stream`, `GET /health`, the same API as `services/f5-tts`) in front of [qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp)'s `tts-server`: Qwen3-TTS 1.7B Base in GGML, on the GPU through Vulkan. It clones one voice from a reference clip and its exact transcript.

Two processes:

| Unit              | Port | What                                                     |
| ----------------- | ---- | -------------------------------------------------------- |
| `qwen-tts-engine` | 5814 | `tts-server` (C++), model kept loaded, OpenAI-compatible |
| `qwen-tts`        | 5813 | `server.py`, the adapter Sovereign calls                 |

## Setup

```bash
# 1. Build qwentts.cpp with Vulkan (needs Vulkan headers + glslc, e.g. the LunarG SDK)
git clone --recurse-submodules https://github.com/ServeurpersoCom/qwentts.cpp.git
cd qwentts.cpp && ./buildvulkan.sh

# 2. Install binary, libs and models into one directory
D=~/.local/share/qwen-tts
mkdir -p $D/bin $D/models
cp build/tts-server build/libggml*.so* $D/bin/
hf download Serveurperso/Qwen3-TTS-GGUF qwen-talker-1.7b-base-Q8_0.gguf qwen-tokenizer-12hz-Q8_0.gguf --local-dir $D/models

# 3. Adapter venv
uv venv -p 3.12 $D/.venv && VIRTUAL_ENV=$D/.venv uv pip install fastapi uvicorn

# 4. Units: fill @@QWEN_TTS_DIR@@, @@SERVICE_DIR@@ (this folder) and @@REF_TEXT@@
#    (the exact transcript of ~/.sovereign/data/voice/references/default.wav)
cp systemd/*.template ~/.config/systemd/user/  # then rename to *.service and edit
systemctl --user daemon-reload && systemctl --user enable --now qwen-tts-engine qwen-tts

# 5. Point Sovereign at it
#    voice.ttsUrl = http://127.0.0.1:5813/synthesize
```

## Notes

- Measured on a Radeon 8060S (Strix Halo): RTF about 0.25 per text in streaming, about 0.3–0.4 per short sentence through this adapter; about 3.7 GB GPU memory.
- `tts-server`'s RUNPATH points at its build directory; the engine unit sets `LD_LIBRARY_PATH` to the install directory instead.
- A fixed `QWEN_TTS_SEED` (default 42) makes replies reproducible.
