# Vui Voice Backend Spec

Status: Draft | Revision: 1 | Date: 2026-06-03

## 1. Overview

Adopt the Vui speech stack ([fluxions-ai/vui](https://github.com/fluxions-ai/vui)) as a live voice-loop backend for Sovereign — streaming STT and TTS with barge-in — while pulling in as little of Vui's process tree, network surface, and feature set as possible.

The integration is **library-mode**: a Sovereign-owned Python sidecar imports a small subset of `vui.*` modules (engine, codec, inference, prompt utils), plus an ASR backend (`faster-whisper` or `moonshine`) and Silero VAD. Sovereign and the sidecar communicate over a **unix domain socket** — no TCP listener, no auth surface, no exposure beyond loopback. The Vui project's WebRTC server, OpenAI Realtime adapter, thoughts/tools router, browser UI, and Claude task sidecar are all **excluded**.

This spec is additive to the existing `@sovereign/voice` module (which proxies external HTTP transcribe/TTS URLs for file-based recordings). The new streaming path coexists with the file path; nothing is removed.

### Status of related work

- `@sovereign/voice` (existing): batch / file-based proxy, `VoiceModule` with `transcribe(Buffer)` and `synthesize(text) → Buffer`. Wired in `bootstrap.ts:250`. **Kept as-is.**
- `TranscriptionProvider` in `@sovereign/core` (`src/transcription.ts:5`): Buffer-in/Buffer-out provider used by `TranscriptionQueue` for recordings/meetings. **Kept; Vui will also implement it so recordings can route through Vui locally.**
- `plans/voice-ui-parity-spec.md`: UI parity with the legacy voice-ui — different scope, no conflict.

---

## 2. Goals

- **Live voice loop**: mic → STT (streaming partials) → existing Sovereign agent → TTS (streaming PCM) → speakers, with barge-in and sentence-level chunking for low first-audio latency.
- **Backend-agnostic core**: voice loop orchestration lives in pure TypeScript against a `VoiceBackend` interface. Vui is one implementation; nothing in the orchestrator names "Vui".
- **Minimal Vui footprint**: depend on `vui` as a git-pinned Python library; import only `vui.engine`, `vui.inference`, `vui.qwen_codec`, `vui.prompt_utils`, `vui.tokenizer`, `vui.model`, and (on Apple Silicon) `vui.mlx.*`. Nothing from `vui.serving.*`.
- **No new network surface**: sidecar listens on `~/.sovereign/data/voice.sock` with `0600` permissions. No TCP, no HTTP, no Bearer tokens to forget. Tailscale Serve continues to front Sovereign itself.
- **Sovereign owns lifecycle**: sidecar is a child of the LaunchAgent-managed Sovereign server. Spawn, health-probe, restart-on-crash, graceful shutdown all in Sovereign-side code.
- **LLM stays in Sovereign**: do not adopt Vui's `voice_turn.py` Ollama loop. STT finals feed Sovereign's existing agent path; agent token stream feeds the TTS chunker.
- **Voice cloning + presets**: ship Vui's four fine-tuned voices (`maeve`, `abraham`, `rhian`, `harry`); allow users to clone from an uploaded `.wav` + transcript.
- **Recordings route through the same backend**: Vui's `faster-whisper` can satisfy the existing `TranscriptionProvider` interface, collapsing batch + streaming behind one local backend.

## 3. Non-goals

- **No WebRTC.** Sovereign already uses WebSocket for everything; adding aiortc to the sidecar pulls in ICE, SDP, codec negotiation, NAT traversal — all unnecessary for a loopback/Tailscale-fronted client. Use plain WS binary frames with PCM16.
- **No OpenAI Realtime API emulation** on Sovereign's surface. We may consume Vui-stream or OpenAI Realtime as an _alternative backend_ later, but Sovereign's own client ↔ server protocol is bespoke and lives in `@sovereign/voice-stream`.
- **No thoughts router / intent tools.** Sovereign already has an agent + tool architecture; Vui's `thoughts.py` would duplicate it.
- **No Claude task sidecar.** Sovereign is the task system.
- **No Vui telemetry.** Set `VUI_TELEMETRY=0` in the spawned env.
- **No multi-tenant voice sessions in v1.** The streaming server already documents the single-active-client assumption; we adopt the same constraint and gate it at the orchestrator (`activeVoiceThread: ThreadKey | null`).
- **No Realtime API on Sovereign's WS yet.** Possible future, not in this spec.

---

## 4. Architecture

```
┌─ client (SolidJS) ──────────────────────────────────────┐
│ <VoiceTurn>                                             │
│  ├─ mic AudioWorklet  (16 kHz mono Int16)               │
│  ├─ Silero VAD (onnxruntime-web, bundled)               │
│  ├─ playback AudioWorklet (24 kHz mono Int16, jitter)   │
│  └─ transcript pane                                     │
└───────────┬─────────────────────────────────────────────┘
            │ WS binary frames (PCM16) + JSON control
            │ (Tailscale Serve → 127.0.0.1:5801)
┌───────────▼─────────────────────────────────────────────┐
│ server (Express + ws)                                   │
│  @sovereign/voice-stream  (NEW)                         │
│   ├─ VoiceBackend interface                             │
│   ├─ VoiceTurnOrchestrator (pure TS, agent-aware)      │
│   ├─ WS frame protocol                                  │
│   └─ session registry (single-active-client gate)       │
│                                                         │
│  @sovereign/voice-vui     (NEW)                         │
│   ├─ implements VoiceBackend                            │
│   └─ sidecar lifecycle (spawn / health / restart)       │
└───────────┬─────────────────────────────────────────────┘
            │ unix socket: ~/.sovereign/data/voice.sock
            │ NDJSON control + length-prefixed binary audio
┌───────────▼─────────────────────────────────────────────┐
│ sidecar (Python, ~300–500 LOC)                          │
│  packages/voice-vui-sidecar/  (NEW, src in repo,        │
│                                pip env via uv)          │
│   imports: vui.engine, vui.inference, vui.qwen_codec,   │
│            vui.prompt_utils, vui.tokenizer, vui.model,  │
│            (darwin/arm64) vui.mlx.tts, vui.mlx.asr      │
│            faster-whisper | moonshine, silero VAD       │
│   excludes: vui.serving.*, aiortc, aiohttp, gradio,     │
│             claude-agent-sdk                            │
└─────────────────────────────────────────────────────────┘
```

**Three reasons this shape is the right one:**

1. **Layering matches Sovereign's existing patterns.** Interfaces in `core` (or a dedicated `voice-stream` package); concrete adapter in a sibling package; downstream consumers wire one to the other in `bootstrap.ts`. Mirrors how `TranscriptionProvider` already works.
2. **Sidecar is the only Vui-aware code.** All Python lives in one place. Swapping Vui for a different speech stack later means writing a new sidecar — the TS surface doesn't change.
3. **No new attack surface.** Unix socket with `0600` perms inherits the file-system trust boundary Sovereign already lives inside. Even Tailscale users with `tailscale serve` only ever reach Sovereign's existing 127.0.0.1 port; the sidecar is invisible.

---

## 5. Package layout

Three new packages in `packages/`. All TypeScript packages follow the existing `types: src/index.ts` + `development: src/index.ts` + `default: dist/index.js` conditional export pattern. Build via tsdown (already adopted repo-wide).

| Path | Language | Role |
| --- | --- | --- |
| `packages/voice-stream/` | TS | `VoiceBackend` interface, `VoiceTurnOrchestrator`, WS frame protocol, session registry. No backend impls. Depends only on `@sovereign/core`. |
| `packages/voice-vui/` | TS | `VoiceBackend` impl + sidecar lifecycle (spawn under Sovereign, health probe, restart). Depends on `@sovereign/voice-stream` and Node's `child_process` / `net`. |
| `packages/voice-vui-sidecar/` | Python | The minimal Python program. `pyproject.toml` + `src/sidecar/`. Built/run via `uv`; lives in the monorepo but managed by uv lockfile, not pnpm. |

The existing `packages/voice/` (HTTP-proxy `VoiceModule`) stays unchanged. Recordings/meetings continue to use it for file-based transcription unless reconfigured to point at the Vui backend (see §11).

### 5.1 Why `voice-stream` and not extending `voice`?

`@sovereign/voice` is HTTP/Buffer-oriented and wired into recordings. Mixing streaming async-iterable APIs into it would either bloat the package or force every consumer (recordings, meetings, tests) to grow a new dimension. Cleaner to keep batch ↔ streaming in separate packages and let `voice-vui` satisfy _both_ surface areas (`StreamingTTSBackend` for live, `TranscriptionProvider` for batch).

### 5.2 Workspace registration

Add to `pnpm-workspace.yaml`: `packages/voice-stream`, `packages/voice-vui`. The Python sidecar is a workspace member only in the filesystem sense — pnpm ignores it.

---

## 6. Public interfaces

### 6.1 TS — `@sovereign/voice-stream`

```ts
// PCM is always little-endian Int16, mono. Sample rates:
//   in  (mic):     16000  ← matches Silero VAD + faster-whisper
//   out (speaker): 24000  ← matches Vui Nano codec output
export type Pcm16 = Int16Array

export interface TTSSynthesisOptions {
  voice: string // preset name or saved clone id
  wps?: number // 0 = let prompt decide; 1–6 = words/sec target
  signal?: AbortSignal // barge-in cancels here
}

export interface StreamingTTSBackend {
  /** Stream PCM out as text arrives. `text` may yield partial sentences;
   *  backend buffers to sentence boundaries internally. */
  synthesize(text: AsyncIterable<string>, opts: TTSSynthesisOptions): AsyncIterable<Pcm16>

  listVoices(): Promise<VoicePreset[]>
  cloneVoice(name: string, wav: Buffer, transcript: string): Promise<VoicePreset>
  deleteVoice(name: string): Promise<void>
}

export interface STTPartial {
  text: string
  final: false
}
export interface STTFinal {
  text: string
  final: true
  durationMs: number
}
export type STTEvent = STTPartial | STTFinal

export interface StreamingSTTBackend {
  /** Open a session, push audio frames in, receive partials + finals out.
   *  Caller closes the input iterable to end the utterance. */
  transcribe(audio: AsyncIterable<Pcm16>, opts?: { language?: string; signal?: AbortSignal }): AsyncIterable<STTEvent>
}

export interface VoiceBackend {
  tts: StreamingTTSBackend
  stt: StreamingSTTBackend
  healthy(): Promise<boolean>
  describe(): { name: string; voices: number; gpu: 'cuda' | 'mlx' | 'cpu' }
}

export interface VoicePreset {
  name: string
  kind: 'preset' | 'clone'
  createdAt: string
}
```

### 6.2 The orchestrator

`VoiceTurnOrchestrator` is the only place that knows about Sovereign threads, the agent loop, and the wire protocol. Backends never see thread keys.

```ts
export interface VoiceTurnDeps {
  backend: VoiceBackend
  agent: AgentSession // existing Sovereign agent surface
  bus: EventBus // existing core event bus
  config: () => VoiceConfig // hot-reload via ConfigStore
}

export interface VoiceTurnSession {
  threadKey: string
  feedMic(pcm: Pcm16): void // client → mic frames
  bargeIn(): void // client VAD speech-start, cancels TTS
  close(): Promise<void>
  on(event: VoiceTurnEvent, cb: (...args: unknown[]) => void): void
}

export interface VoiceTurnOrchestrator {
  start(threadKey: string, deps: VoiceTurnDeps): Promise<VoiceTurnSession>
  active(): string | null // currently active thread (single-tenant)
}
```

`VoiceTurnEvent` emits over the bus _and_ over the WS to the originating client:

| Event               | Payload                 | Purpose                                  |
| ------------------- | ----------------------- | ---------------------------------------- |
| `voice.turn.opened` | `{ threadKey }`         | Client UI flips to live state            |
| `voice.stt.partial` | `{ text }`              | Live transcript                          |
| `voice.stt.final`   | `{ text, durationMs }`  | Locks transcript, hands to agent         |
| `voice.tts.chunk`   | `Pcm16` (binary frame)  | Outbound audio                           |
| `voice.tts.done`    | `{ durationMs }`        | TTS finished naturally                   |
| `voice.bargein`     | `{}`                    | TTS cancelled by client VAD              |
| `voice.turn.closed` | `{ threadKey, reason }` | Session torn down                        |
| `voice.error`       | `{ code, message }`     | Sidecar crash, backend unavailable, etc. |

### 6.3 WS frame protocol (`@sovereign/voice-stream/protocol`)

Sovereign's WS is already in use for thread/message events. Voice adds a `voice/*` namespace; existing routes are untouched.

**Control frames** (JSON, existing envelope):

```jsonc
{ "type": "voice.start",       "threadKey": "...", "voice": "maeve" }
{ "type": "voice.bargein" }
{ "type": "voice.stop" }
```

**Binary frames** (new): a one-byte type prefix followed by raw PCM16-LE. Avoids the base64 overhead of stuffing audio into JSON.

| Byte 0 | Direction | Body                                  |
| ------ | --------- | ------------------------------------- |
| `0x01` | C → S     | mic chunk (16 kHz, ~20ms = 640 bytes) |
| `0x02` | S → C     | tts chunk (24 kHz, variable)          |

(Reserved: `0x03` codec codes for future zero-copy paths.)

The WS upgrade negotiates `Sec-WebSocket-Protocol: sovereign-voice.v1` so we can version-bump cleanly.

### 6.4 Sidecar wire protocol (unix socket)

Two channels multiplexed on one connection — same one-byte-prefix trick. Control is **newline-delimited JSON**; audio is **length-prefixed binary** (4-byte BE u32 length, then PCM16-LE).

| Byte 0 | Direction | Body                                 |
| ------ | --------- | ------------------------------------ |
| `0x10` | both      | NDJSON control message (single line) |
| `0x11` | both      | Binary audio frame: `<u32 len><pcm>` |

**Control ops** (`op` field):

| op | dir | payload | reply |
| --- | --- | --- | --- |
| `health` | →sidecar | `{}` | `{ ok: true, gpu, voice_count }` |
| `tts.synthesize.open` | →sidecar | `{ id, voice, wps }` | `{ id, ok }` then audio frames tagged with `id` |
| `tts.synthesize.feed` | →sidecar | `{ id, text }` | (none — chunks accumulated, sentence-flush internally) |
| `tts.synthesize.end` | →sidecar | `{ id }` | trailing audio + `{ id, done: true }` |
| `tts.cancel` | →sidecar | `{ id }` | `{ id, cancelled: true }` |
| `tts.list_voices` | →sidecar | `{}` | `{ voices: [...] }` |
| `tts.clone_voice` | →sidecar | `{ name, transcript }` + audio frames + end | `{ name, ok }` |
| `tts.delete_voice` | →sidecar | `{ name }` | `{ name, ok }` |
| `stt.session.open` | →sidecar | `{ id, model, language? }` | `{ id, ok }` |
| `stt.session.feed` | →sidecar | (binary, id implicit in session) | partials: `{ id, partial: "..." }` |
| `stt.session.close` | →sidecar | `{ id }` | `{ id, final: "...", duration_ms }` |
| `event.log` | ←sidecar | `{ level, msg, ts }` | (Sovereign tees to `data/logs/voice.log`) |

Binary audio frames carry a 16-byte header before PCM: `<u32 op_id><u32 seq><u32 len><u8 channel><u8 sr_idx><u16 reserved>`, where `sr_idx` is 0=16 kHz, 1=24 kHz. Lets us multiplex multiple in-flight TTS/STT ops on the same socket without ordering ambiguity.

---

## 7. Sidecar internals

### 7.1 Project layout

```
packages/voice-vui-sidecar/
  pyproject.toml
  uv.lock
  src/sidecar/
    __init__.py
    __main__.py          # entry: `python -m sidecar --socket <path>`
    transport.py         # NDJSON + binary framing over a unix socket
    tts.py               # wraps vui.engine.Engine + Row, sentence chunker
    stt.py               # faster-whisper / moonshine streaming session
    vad.py               # Silero VAD (optional server-side)
    voices.py            # preset + clone registry, prompt_utils glue
    config.py            # env vars: VUI_TELEMETRY=0, model paths, etc.
    log.py               # structured log → control channel
  tests/
    test_transport.py
    test_tts.py
    test_stt.py
```

### 7.2 `pyproject.toml`

```toml
[project]
name = "sovereign-voice-vui-sidecar"
version = "0.1.0"
requires-python = ">=3.12,<3.13"

dependencies = [
  # Pinned to a Vui commit (Vui doesn't publish to PyPI as of 2026-06).
  "vui @ git+https://github.com/fluxions-ai/vui@<PIN_SHA>",
  "faster-whisper>=1.0",
  "onnxruntime>=1.19",
  "numpy>=1.24",
  "soundfile>=0.12",
]

[project.optional-dependencies]
mlx = ["vui[mlx]"]              # darwin/arm64 path
moonshine = ["moonshine-voice"] # CPU-only ASR alternative

[tool.uv.sources]
# Inherits Vui's pinned flash-attn wheel transitively on Linux/CUDA.
```

`uv` manages the venv at `packages/voice-vui-sidecar/.venv/`. The TS adapter invokes `uv run python -m sidecar`, so the lockfile is the source of truth and we never run system `pip`.

### 7.3 TTS path

`tts.py` owns a single `vui.engine.Engine` instance + a long-lived `Row`. For each `tts.synthesize.open`:

1. Resolve the voice: preset → load `prompts/<name>.safetensors` + `.txt`; clone → load from `~/.sovereign/data/voice/clones/`.
2. Stream text into the engine via `vui.inference.chunk_text` for sentence-boundary chunking (matches Vui's own approach in `drains.py`).
3. Emit codec codes → decode → 24 kHz PCM frames → binary write to the socket, tagged with `op_id` and monotonic `seq`.
4. On `tts.cancel`, set a stop flag the engine respects between codebook frames; flush nothing further.

Pick up Vui's `n_codebooks` knob and the `wps` conditioning vector from the open op — these are the two production-tunable levers worth exposing.

### 7.4 STT path

Default backend: `faster-whisper` with `distil-small.en` (matches Vui's default). One persistent worker per session:

```python
model = WhisperModel(name, device="cuda", compute_type="float16")
# Streaming wrapper: 30s sliding window, emit partial every 0.5s,
# final on session.close.
```

Apple Silicon path swaps to `vui.mlx.asr` if available; CPU-only falls back to Moonshine if the extra is installed.

VAD: client-side Silero (see §9.3); the sidecar accepts already-gated audio. Server-side Silero is wired but disabled by default (would force every mic chunk through Python regardless of speech state).

### 7.5 Logs + telemetry

- All sidecar logs go over the control channel (`event.log`); TS adapter writes them to `~/.sovereign/data/logs/voice.log` with rotation matching the existing logger.
- `VUI_TELEMETRY=0` set unconditionally in the spawned env.
- Sidecar process labels itself `sovereign-voice-vui` for `ps`.

---

## 8. Server-side integration

### 8.1 Bootstrap wiring (`packages/server/src/bootstrap.ts`)

After the existing voice module setup (~line 250):

```ts
import { createVoiceTurnOrchestrator } from '@sovereign/voice-stream'
import { createVuiVoiceBackend } from '@sovereign/voice-vui'

const voiceBackend = await createVuiVoiceBackend({
  socketPath: path.join(dataDir, 'voice.sock'),
  pythonRunner: cfg.voice.vui.pythonRunner, // "uv run python" by default
  sidecarRoot: resolveWorkspacePath('packages/voice-vui-sidecar'),
  voice: cfg.voice.vui.defaultVoice,
  asr: cfg.voice.vui.asrModel,
  env: { VUI_TELEMETRY: '0' }
})

const voiceOrchestrator = createVoiceTurnOrchestrator({
  backend: voiceBackend,
  bus,
  config: () => configStore.get<VoiceConfig>('voice')
})

// Hot-reload: config change re-resolves voice/asr without restart.
configStore.onChange('voice', () => voiceBackend.reload(configStore.get('voice')))

// Bridge into Vui-as-TranscriptionProvider for recordings (optional, gated):
if (cfg.voice.vui.useForRecordings) {
  transcriptionQueue = createTranscriptionQueue(
    createVuiTranscriptionProvider(voiceBackend) // exported from voice-vui
  )
}
```

WS upgrade for voice frames goes through the existing WS server with `Sec-WebSocket-Protocol` check; voice routes register in `packages/voice-stream/src/routes.ts`.

### 8.2 Agent coupling

`VoiceTurnOrchestrator` does not import the concrete agent module; it takes an `AgentSession` interface (already extracted in `@sovereign/agent-backend` per the existing membrane work). On `stt.final`:

```ts
const agentReply = agent.send({ role: 'user', content: sttFinal.text, source: 'voice' })
// agentReply is AsyncIterable<string>  ← existing token-stream surface
await backend.tts.synthesize(agentReply, { voice: session.voice, signal: session.abort })
```

If the agent emits a tool call, the orchestrator delegates to the agent's existing tool runtime; the voice loop doesn't grow tool-awareness.

### 8.3 Single-active-client gate

`VoiceTurnOrchestrator.start()` rejects with `ERR_VOICE_BUSY` if another thread holds the lock. UI surface: a "Voice in use by thread X" banner with a take-over button. Matches Vui's documented single-tenant assumption.

### 8.4 Membrane awareness

Voice presets and the per-thread default voice are membrane-scoped — `personal`, `coasys`, etc. can each have their own preferred voice. Config shape in §11; resolution happens in the orchestrator (`config().vui.voicesByMembrane?.[thread.membraneId] ?? config().vui.defaultVoice`).

---

## 9. Client-side integration

### 9.1 Components (`packages/client/src/voice/`)

```
voice/
  VoiceTurn.tsx           # main component, mic button + transcript + audio
  VoiceSessionStore.ts    # Solid store: state machine (idle/listening/replying)
  audio/
    mic-worklet.ts        # AudioWorklet: 16 kHz Int16 capture
    playback-worklet.ts   # AudioWorklet: 24 kHz Int16 jitter-buffered playback
    silero-vad.ts         # onnxruntime-web wrapper
    silero_vad.onnx       # bundled, copied from Vui (Apache 2.0)
  voice-ws.ts             # WS client for voice frames
```

`VoiceTurn` mounts inside the thread view, scoped to one thread at a time. The store transitions:

```
idle ─(click mic)──► listening ─(VAD speech)─► capturing ─(VAD silence)─► replying ─(tts.done)─► listening
                          │                          │                       │
                          │                          │                       └─(speech detected)─► bargein → capturing
                          └─(stop)──► idle           └─(stop)──► idle
```

### 9.2 Audio capture

- `navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true } })`
- `AudioWorklet` downsamples (if the device gives 48 kHz, do polyphase) and converts to Int16. ~20 ms frames = 320 samples = 640 bytes.

### 9.3 Client-side VAD

- `onnxruntime-web` + bundled `silero_vad.onnx` (~1.8 MB, Apache 2.0; copy from `/tmp/vui-review/src/vui/serving/stream/silero_vad.onnx`).
- Runs in the AudioWorklet's `MessagePort` worker, ~5 ms per frame.
- Gates the WS upload: mic frames only flow during `speech: true`. Reduces bandwidth, latency, and keeps silence off the server.
- Speech-start during `replying` triggers `voice.bargein` over the control channel; client also stops the playback worklet immediately for instant feedback.

### 9.4 Playback

- One `AudioWorkletNode` consuming binary `0x02` frames into a ~300 ms jitter buffer at 24 kHz.
- Glitch suppression: linear interpolation across a missed frame; underrun emits a silent 10 ms pad without resetting clock.

---

## 10. Voice prompts & cloning

### 10.1 Preset bundle

Sovereign ships the four Vui-fine-tuned presets (`maeve`, `abraham`, `rhian`, `harry`) at `~/.sovereign/data/voice/prompts/`. First-run download:

- Pull `prompts/<name>.safetensors` + `.txt` from `https://huggingface.co/fluxions/vui` via `huggingface_hub` (sidecar dep).
- Cache invalidation: keyed by checkpoint id (Vui's `_ckpt_id` scheme from `tts_worker.py:39`).

### 10.2 Voice cloning UI

Settings → Voice → Clone:

1. Upload `.wav` (≥30 s recommended, ≤6 min context window).
2. Provide a verbatim transcript.
3. Optionally name the voice.
4. Server forwards to sidecar via `tts.clone_voice`; sidecar runs `vui.prompt_utils.build_prompt_segments` (handles long-prompt chunking, forced alignment, sentence-boundary splits).
5. Result saved to `~/.sovereign/data/voice/clones/<name>.safetensors` + `.txt`. Available immediately.

### 10.3 Anti-abuse

Mirror Vui's responsible-use stance. Surface a one-time consent banner on first clone: _"You are responsible for the voices you create. Clones of real people require their explicit consent."_ Logged to `data/logs/voice.log` for audit.

Future: optional AudioSeal watermarking — out of scope for v1 but tracked in §17.

---

## 11. Configuration

Add a `voice` section to `~/.sovereign/config.json` (existing keys preserved):

```jsonc
{
  "voice": {
    // Legacy HTTP-proxy module — kept as-is.
    "transcribeUrl": null,
    "ttsUrl": null,
    "timeoutMs": 30000,

    // NEW — live voice loop via Vui sidecar.
    "vui": {
      "enabled": true,
      "pythonRunner": "uv run python", // override for non-uv envs
      "defaultVoice": "maeve",
      "asrModel": "fwhisper.distil-small.en",
      "wps": 0, // 0 = natural pace
      "nCodebooks": 0, // 0 = all 16; lower = faster, less stable
      "voicesByMembrane": {
        "personal": "maeve",
        "coasys": "abraham"
      },
      "useForRecordings": false // re-route TranscriptionQueue
    }
  }
}
```

All config is hot-reloadable through the existing `ConfigStore.onChange('voice', ...)` hook.

---

## 12. Security model

| Concern | Mitigation |
| --- | --- |
| Unauthorised access to TTS/STT | Sidecar listens on a unix socket; no TCP. Socket file `0600` owned by Sovereign's UID. |
| Voice frames over the network | Same Tailscale Serve path as the rest of Sovereign — WireGuard auth, tailnet ACLs. Server bind stays 127.0.0.1. |
| Sidecar crash → orphan listener | Sidecar removes the socket on exit; adapter unlinks on spawn. PID file at `data/voice-vui.pid`. |
| Voice cloning misuse | Consent banner on first clone; usage logged; future watermarking. |
| Credential exposure | Sidecar does not see any Sovereign credentials. No `~/.claude` mount. No `ANTHROPIC_*` env vars. |
| Telemetry leakage | `VUI_TELEMETRY=0` set in spawned env. Verified with a unit test in §14.4. |
| Recording payloads in logs | `event.log` from sidecar carries no transcript text by default; `level=debug` opt-in unmasks. |

---

## 13. Lifecycle, build, deploy

### 13.1 Sidecar lifecycle

`createVuiVoiceBackend` spawns the sidecar as a child of the Sovereign server process:

```ts
const proc = spawn(cfg.pythonRunner, ['-m', 'sidecar', '--socket', socketPath], {
  cwd: cfg.sidecarRoot,
  env: { ...process.env, VUI_TELEMETRY: '0' },
  stdio: ['ignore', 'pipe', 'pipe'] // logs come over the socket; stderr is a fallback
})
proc.on('exit', (code, sig) => onCrash(code, sig))
```

- **Health probe**: TS adapter sends `op:"health"` every 5 s. Two missed → restart with exponential backoff (1 s, 2 s, 5 s, 15 s, 60 s).
- **Graceful shutdown**: on `SIGTERM` from launchd, TS adapter sends `op:"shutdown"`, waits ≤2 s, then `SIGKILL`s.
- **Cold-start gating**: orchestrator surfaces a `voice.backend.starting` event until the first `health` reply succeeds; client UI shows a "warming up" state.

### 13.2 Build integration

- `bin/sovereign build` extends to:
  - `pnpm -r --filter @sovereign/voice-stream build`
  - `pnpm -r --filter @sovereign/voice-vui build`
  - `cd packages/voice-vui-sidecar && uv sync` (idempotent; skipped if `uv.lock` unchanged)
- The Python sidecar is **not** packaged into the Sovereign tarball; it lives in the repo and runs from source.

### 13.3 First-run UX

If `voice.vui.enabled = true` and the sidecar venv doesn't exist:

1. Server emits `voice.backend.installing` event.
2. Client shows a "Setting up voice (≈1 min, downloading model on first run)" banner.
3. Adapter runs `uv sync` then `huggingface_hub.snapshot_download` for `fluxions/vui`.

### 13.4 Apple Silicon

- Auto-detected (`process.arch === 'arm64' && process.platform === 'darwin'`).
- Adds `--extra mlx` to the `uv sync` command.
- Sidecar imports `vui.mlx.tts` instead of CUDA path; falls back to CPU on import error.

---

## 14. Testing strategy

### 14.1 TS unit tests

- `voice-stream/src/protocol.test.ts`: WS frame encode/decode round-trips for control + binary; protocol version negotiation.
- `voice-stream/src/orchestrator.test.ts`: state machine transitions, barge-in cancels in-flight synth, single-active-client gate, abort signal propagation. Uses a `MockVoiceBackend`.
- `voice-vui/src/lifecycle.test.ts`: spawn / health probe / restart-on-crash / graceful-shutdown semantics. Mocks `child_process` and the unix socket.

### 14.2 Sidecar tests

- `tests/test_transport.py`: NDJSON + binary framing fuzz.
- `tests/test_tts.py`: short synthesis end-to-end against a tiny stub `Engine` (Vui's own `engine.py` is too heavy for CI; we mock at the engine boundary and integration-test gated on `VUI_GPU=1`).
- `tests/test_stt.py`: deterministic transcript on a bundled 3 s WAV.

### 14.3 Integration tests

- `packages/server/src/__integration__/voice.test.ts`: spawn a real sidecar with a stubbed Engine (no GPU needed); run a turn end-to-end via WS; assert event order, transcript final, audio bytes received.
- Gated under `pnpm test:integration` so default `pnpm test` stays fast.

### 14.4 Security smoke tests

- Sidecar TCP scan: bind a probe to the unix socket directory and assert no listener on `127.0.0.1:any` or `0.0.0.0:any` matches the sidecar PID's `lsof` output.
- Env audit: assert `VUI_TELEMETRY=0` is in the spawned process's `/proc/<pid>/environ` (Linux) / `ps eww` (macOS).

### 14.5 Manual verification

For UI changes, follow the existing Sovereign rule — "verify in the running app." Specifically:

- Cold-start: open thread → click mic → say "hello" → expect transcript partial within ~400 ms, final within ~800 ms, first TTS audio within ~600 ms after final.
- Barge-in: start a long TTS reply, speak again → playback stops within 100 ms, new STT session begins.
- Voice clone: upload sample, synthesize same sentence → audible difference from `maeve`.

---

## 15. Phased rollout

Each phase ships independently, behind `voice.vui.enabled`. Acceptance criteria are binding.

### Phase A — Interfaces + null adapter

**Deliverables:**

- `packages/voice-stream/` with all interfaces, frame protocol, orchestrator, **null backend** (returns silence + canned partials).
- WS routes registered; client `<VoiceTurn>` shell with mic capture + playback worklets wired against the null adapter (echoes audio back).
- No Python yet.

**Acceptance:**

- Mic frames flow from client → server → client (echo) at <200 ms loopback latency.
- Orchestrator unit tests pass.
- `pnpm check && pnpm test` clean.

### Phase B — Sidecar v0 (TTS only)

**Deliverables:**

- `packages/voice-vui-sidecar/` with TTS path implemented; `uv sync` brings up the venv.
- `packages/voice-vui/` adapter spawns the sidecar, implements `StreamingTTSBackend` only (STT stays null-adapter).
- "Speak as" textbox in client → server synthesizes via Vui → audio plays.

**Acceptance:**

- `maeve` synthesizes "hello world" with audible output in <1.5 s end-to-end on the dev box.
- Sidecar restart-on-crash works: `kill -9 <sidecar-pid>` → adapter relaunches within 5 s.
- `lsof -p <sidecar>` shows zero TCP listeners.

### Phase C — Sidecar v1 (STT)

**Deliverables:**

- STT path in sidecar (faster-whisper); `StreamingSTTBackend` wired.
- Client-side Silero VAD gates the mic stream.

**Acceptance:**

- Spoken "hello world" → final transcript within 800 ms on the dev box.
- Mic frames cease when VAD reports silence (Wireshark / `nc -lU` confirmation).

### Phase D — Live voice loop + agent integration

**Deliverables:**

- `VoiceTurnOrchestrator` wired through the existing `AgentSession` interface.
- Barge-in implemented end-to-end.
- Single-active-client gate.

**Acceptance:**

- Full ASR → agent → TTS round-trip; transcript visible, reply audible.
- Mid-reply speech cancels TTS within 150 ms.
- Second thread attempting voice while first is active receives `ERR_VOICE_BUSY`.

### Phase E — Voice management UI + cloning

**Deliverables:**

- Settings page: pick default voice, per-membrane voice override, clone upload.
- Sidecar `tts.clone_voice` op; consent banner on first clone.

**Acceptance:**

- Cloned voice from a 30 s sample is selectable and audibly distinct.
- Membrane switch changes default voice on next turn.

### Phase F — Recordings via Vui (optional)

**Deliverables:**

- `createVuiTranscriptionProvider(voiceBackend)` satisfying the existing `TranscriptionProvider` interface.
- Config flag `voice.vui.useForRecordings` re-routes the queue.

**Acceptance:**

- Existing recordings tests pass with the queue pointed at the Vui provider.
- Side-by-side comparison: Vui faster-whisper output matches existing HTTP backend on a fixture clip within edit-distance threshold.

### Phase G — Polish

- MLX path verified on Apple Silicon.
- Latency profiling + the two Vui knobs (`n_codebooks`, `wps`) exposed in the settings UI.
- Docs update: `~/.sovereign/membranes/personal/CONTEXT.md` notes the sidecar.

---

## 16. Migration from existing `@sovereign/voice`

No breaking change. The existing module continues to serve recordings/meetings via HTTP. Bootstrap wiring grows new lines for the streaming path; existing lines untouched.

Future deprecation path (not in this spec): if the Vui backend proves stable and `useForRecordings=true` is the common case, the legacy HTTP-proxy `VoiceModule` could be retired — but only after at least one minor release running both side by side.

---

## 17. Open decisions

These are the contested choices I'd want a call on before Phase A starts:

1. **Vui git-pin vs vendor.** Pinning `vui @ git+https://github.com/fluxions-ai/vui@<sha>` in `pyproject.toml` is the lowest-friction option but couples our sidecar venv to GitHub uptime and the upstream history. Alternative: vendor the specific modules we use into `packages/voice-vui-sidecar/src/sidecar/vendor/vui/`. Vendoring loses upstream patches; pinning loses reproducibility if GitHub goes away. **Recommendation: pin a tagged release (when Vui starts tagging), pin a sha until then.**

2. **`useForRecordings` default.** Off in v1 keeps the legacy HTTP path unaffected. On would consolidate everything behind Vui but risks regressing recordings if the local sidecar is unavailable. **Recommendation: off in v1; flip to on by default in a later release after Phase F bake-in.**

3. **Single-active-client gate vs per-thread sessions.** Vui-the-server documents single-tenant; Vui-the-engine could plausibly fan out if the GPU has headroom. Multi-session would mean per-thread KV state, queue contention on the codec, and a richer protocol. **Recommendation: single-active in v1; revisit if users complain.**

4. **Telemetry policy.** We unconditionally disable Vui's telemetry. Sovereign has its own telemetry posture — does the voice loop need its own opt-in event ("voice turn completed, duration N ms") for product analytics, or stay silent? **Recommendation: silent in v1. Add later if needed.**

---

## 18. Out of scope / future work

- **OpenAI Realtime API alternative backend.** A `voice-openai-realtime` adapter would let users point Sovereign at OpenAI's hosted endpoint, or at a self-hosted Vui-stream, without the local sidecar. Not in v1.
- **WebRTC transport.** If cell-network latency becomes a problem, we'd add an `aiortc`-based variant — but it's a heavy dep and the loopback/Tailscale path doesn't need it.
- **AudioSeal / C2PA watermarking** of TTS output for misuse provenance. Tracked, not in v1.
- **Multi-language ASR** (`vui` defaults to English; `whisper-large-v3` for multilingual would need a config knob and probably a separate sidecar variant).
- **Diarisation** in streaming STT (the existing `TranscriptionResult.speakers` shape exists but Vui's path doesn't populate it).
- **Wake-word.** Sovereign UX is intentionally push-to-talk; we don't ship one.

---

## 19. Effort shape (no estimates)

For sequencing only — not a calendar.

| Phase | Surface                                         |
| ----- | ----------------------------------------------- |
| A     | TS only; ~3 packages stand up, no Python        |
| B     | First Python; uv venv; HF model download        |
| C     | STT loop; client VAD; bandwidth gating          |
| D     | Agent integration; barge-in; single-tenant gate |
| E     | Settings UI; consent flow; clone storage        |
| F     | Recordings re-routing                           |
| G     | MLX verification; latency tuning; docs          |

Phases A–D are the spine; E–G are independent and parallelisable.
