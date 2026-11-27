# Voice replies (`packages/voice/`)

## Voice replies: one speaker per device name

TTS routes by device **name** (announced with `ws.device-name`), because a page refresh mints a fresh connection deviceId. Several connections share a name on one machine: browser tabs, plus a voice node or the Android app. `wsHandler.sendSpeechToDeviceName` gives the audio to **one** of them and the reply without `audio` to the rest, so their UI still updates:

1. the first live entry of `prefer`: the connection that spoke the reply's previous chunk, then the one the voice request came from (`origin.deviceId`);
2. a voice client: `client: 'voice-node'` in `ws.device-name`, or a non-browser User-Agent on the upgrade request;
3. the browser tab the user touched last (`ws.active`: the client sends it on focus, on input, throttled to 5 s, and on reconnect — only once the page has had a user gesture, since autoplay keeps audio suspended before that, and never while disconnected);
4. the newest connection.

`voice-response.ts` pins a reply's later chunks to the connection that spoke the chunk before, and forgets the pin when the reply ends, so a reply never splits across tabs and an old reply never claims a new one. With nothing connected under the name, the push fallback sends the text once per reply. The server decides this because a client-side race cannot: Chrome throttles background-tab timers to the same one-second tick, so hidden tabs that raced over a BroadcastChannel all woke together and all played. Wind-tunnel s37 covers it.

## Voice replies: the speech queue

Two replies can stream at once (two threads finish together), and their chunks interleave on the wire. `speak()` tags every `voice.tts.audio` with an `utterance` id: one per reply, shared by all its chunks. Every player runs the same queue — web `client/src/features/voice/tts-queue.ts`, voice node `services/voice-node/tts_queue.py`, Android `SpeechQueue.kt` — with the same rules:

- Whole replies play one after another, in arrival order. Nothing cuts a reply off except an explicit stop (web: "Stop playback" in a message's context menu).
- A reply waits for its own late chunks instead of jumping to the next reply; after 20 s without a chunk it gives up, and late chunks of a finished reply are dropped.
- A short cue (two tones, 660 → 880 Hz) sounds before a reply that starts within 3 s of the previous one ending.
- Acks and "Play aloud" go ahead of replies still waiting, never ahead of the one playing.
- A message without `utterance` (older server) falls back to thread + kind, renewed at chunk 0.

Wind-tunnel s39 checks the server half: utterance ids, one owner each, chunks in order. The queue tests (vitest, `python3 -m unittest test_tts_queue`, `./gradlew testDebugUnitTest`) pin the player half.
