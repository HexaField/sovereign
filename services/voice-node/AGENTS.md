# Voice node push-to-talk

Push-to-talk streams, the same `voice-stream` channel the web mic uses, so it fills the dictation draft bubble:

```
keys down → voice-stream.start {format:'pcm16', sampleRate:16000, deliver:'presence'}
held      → voice-stream.chunk {audio}  (one 80 ms frame each, raw 16-bit PCM)
keys up   → voice-stream.stop
server    → voice-stream.draft {source, threadId: presence, text, done} to every connection
            sharing the node's device name; on stop it sends the final text to the presence
            thread (voice origin + device name, so TTS answers on the node), then done: true
client    → features/voice/remote-dictation.ts shows it as a read-only draft (no tap-to-edit)
```

- **Windowed transcription (pcm16 only, `packages/voice/src/streaming.ts`).** Each pass transcribes only the audio after the last committed cut. Once that tail reaches 20 s, the session cuts it at the quietest 200 ms after the first 10 s, transcribes up to the cut once and keeps that text; the same pass then transcribes the rest, so the draft never loses words. The client's `sampleRate` must be 8000–48000 (else 16000). A pass therefore stays a few seconds long however long the keys stay held (4 min of speech: no errors, ≤ 5 s between updates). webm cannot be cut without decoding, so the browser path still re-transcribes the whole recording each pass and slows past about 80 s (15 s pass timeout).
- **Order:** the PTT thread queues WebSocket messages into one asyncio queue that a single task sends; a reconnect drops whatever the dead connection left. Server side, one device's stops send to presence in order, and only the device's current stream may update or clear the draft (a new hold can start before the last one's send resolves).
- **Local dictation wins:** a tab dictating in its own InputArea keeps its draft; node drafts wait until it ends.
- **Fallback:** with the WebSocket down, or a server without `voice-stream` (error `UNKNOWN_CHANNEL`/`UNKNOWN_TYPE`), the node uploads on release. The node also keeps every frame while it streams: if the connection drops or reconnects mid-hold, or the server refuses the stream, the whole hold uploads on release to `/api/voice/transcribe`. There `--max-capture` sets the segment length (120 s): a longer hold sends a segment and keeps recording; POSTs go one at a time with a 150 s timeout. Wake word mode keeps `--max-capture` as its hard cap (30 s).
- **Coverage:** `ws.test.ts` (draft fan-out, send-then-clear, send order, stop/start/disconnect races, browser streams untouched), `streaming.test.ts` (windowing), `remote-dictation.test.ts`, `services/voice-node/test_ptt_stream.py` (stream + mid-hold fallback), wind-tunnel s40.
