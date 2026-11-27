# TTS services

`voice.ttsUrl` points at one HTTP service with a fixed API: `POST /synthesize` `{text}` → WAV, `POST /synthesize/stream` `{text}` → NDJSON audio chunks in play order (`index`, `total`, `sentence` = text to show, `audio` = base64 WAV, `durationMs`, `rtf`, `done`; f5-tts sends one per sentence, qwen-tts one per pause), `GET /health`. Any engine that serves this API can be swapped in by changing `voice.ttsUrl` alone.

- `services/f5-tts/`: F5-TTS on PyTorch ROCm (flow matching, voice clone; weights CC-BY-NC).
- `services/qwen-tts/`: an adapter in front of [qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp)'s `tts-server` (Qwen3-TTS 1.7B Base, GGML on Vulkan; code MIT, weights Apache-2.0). The adapter registers one cloned voice (`QWEN_TTS_REF_AUDIO` + `QWEN_TTS_REF_TEXT`) and re-registers it if the engine restarts. Unit templates in `systemd/`.
- **Stream a whole reply as one engine request.** One request per sentence let every sentence pick its own tone (speaker similarity between sentences 0.63 per sentence vs 0.79 in one request; brightness spread 1,140 vs 230 Hz). qwen-tts sends the text once in `pcm` mode and cuts the stream at pauses (first chunk 0.6–2 s, then 2–6 s), so speech still starts in about 1 s.
- **qwentts.cpp ignores `seed` while sampling:** the same text twice gives different audio unless both `temperature` and `subtalker_temperature` are 0 (greedy is repeatable).
- **The reference transcript must match the clip exactly.** In-context cloning (both engines) aligns the transcript to the audio; words that are not in the clip degrade every reply.
- **On AMD iGPUs, prefer GGML/Vulkan over PyTorch ROCm for autoregressive TTS.** PyTorch ROCm recompiles kernels for each new sequence length and launches small kernels slowly (Qwen3-TTS: RTF 1.7–22 on PyTorch, 0.25 on qwentts.cpp Vulkan).
