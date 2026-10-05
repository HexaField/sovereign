"""Speech queue for the voice node — the same rules as the web client
(packages/client/src/features/voice/tts-queue.ts).

Whole replies play one after another, never cut off for another. A reply
(utterance) arrives as one clip or as streamed chunks; its chunks play in
order and the queue waits for late chunks instead of jumping ahead. A short
cue sounds between back-to-back replies. An acknowledgement goes ahead of
replies still waiting, but never interrupts the one playing.

Playback is injected (async play(clip), async cue()), so tests run without
audio hardware.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Awaitable, Callable


@dataclass
class _Utterance:
    id: str
    priority: bool
    clips: list[bytes] = field(default_factory=list)
    done: bool = False
    wake: asyncio.Event = field(default_factory=asyncio.Event)


class SpeechQueue:
    def __init__(
        self,
        play: Callable[[bytes], Awaitable[None]],
        cue: Callable[[], Awaitable[None]],
        stall_s: float = 20.0,
        cue_within_s: float = 3.0,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._play = play
        self._cue = cue
        self._stall_s = stall_s
        self._cue_within_s = cue_within_s
        self._clock = clock
        self._queue: list[_Utterance] = []
        self._current: _Utterance | None = None
        # Replies already played or given up on: a late chunk must not restart one.
        self._finished: OrderedDict[str, None] = OrderedDict()
        self._worker: asyncio.Task | None = None
        # When speech last finished playing: a reply starting soon after gets the cue.
        self._last_ended = float("-inf")

    def enqueue(self, utterance: str, clip: bytes, last: bool, priority: bool = False) -> None:
        if utterance in self._finished:
            return
        u = self._find(utterance)
        if u is None:
            u = _Utterance(id=utterance, priority=priority)
            # Priority goes ahead of replies still waiting, after earlier priority ones.
            at = next((i for i, q in enumerate(self._queue) if not q.priority), len(self._queue)) if priority else len(self._queue)
            self._queue.insert(at, u)
        if u.done:
            return
        u.clips.append(clip)
        if last:
            u.done = True
        u.wake.set()
        if self._worker is None or self._worker.done():
            self._worker = asyncio.get_running_loop().create_task(self._run())

    def active(self) -> bool:
        return self._worker is not None and not self._worker.done()

    async def drain(self) -> None:
        """Wait until everything queued has played (tests)."""
        while self.active():
            await self._worker

    def _find(self, utterance: str) -> _Utterance | None:
        if self._current is not None and self._current.id == utterance:
            return self._current
        return next((u for u in self._queue if u.id == utterance), None)

    def _finish(self, u: _Utterance) -> None:
        u.done = True
        self._finished[u.id] = None
        while len(self._finished) > 200:
            self._finished.popitem(last=False)

    async def _next_clip(self, u: _Utterance) -> bytes | None:
        while not u.clips:
            if u.done:
                return None
            u.wake.clear()
            try:
                await asyncio.wait_for(u.wake.wait(), self._stall_s)
            except asyncio.TimeoutError:
                return None  # stalled: give up on the rest of this reply
        return u.clips.pop(0)

    async def _run(self) -> None:
        while self._queue:
            u = self._queue.pop(0)
            self._current = u
            started = False
            while (clip := await self._next_clip(u)) is not None:
                if not started:
                    started = True
                    if self._clock() - self._last_ended < self._cue_within_s:
                        await self._cue()
                await self._play(clip)
                self._last_ended = self._clock()
            self._finish(u)
            self._current = None
