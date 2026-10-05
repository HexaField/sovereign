"""Tests for the voice node speech queue. Run: python3 -m unittest test_tts_queue"""

import asyncio
import unittest

from tts_queue import SpeechQueue


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def make(stall_s=5.0, cue_within_s=3.0):
    log: list[str] = []
    clock = FakeClock()

    async def play(clip: bytes):
        log.append(clip.decode())
        clock.t += 0.1
        await asyncio.sleep(0)

    async def cue():
        log.append("cue")

    return SpeechQueue(play, cue, stall_s=stall_s, cue_within_s=cue_within_s, clock=clock), log, clock


class SpeechQueueTest(unittest.IsolatedAsyncioTestCase):
    async def test_interleaved_replies_play_whole_one_at_a_time_with_a_cue(self):
        q, log, _ = make()
        q.enqueue("A", b"A0", last=False)
        q.enqueue("B", b"B0", last=False)
        q.enqueue("A", b"A1", last=False)
        q.enqueue("B", b"B1", last=True)
        q.enqueue("A", b"A2", last=True)
        await q.drain()
        self.assertEqual(log, ["A0", "A1", "A2", "cue", "B0", "B1"])

    async def test_waits_for_a_late_chunk_instead_of_jumping_ahead(self):
        q, log, _ = make()
        q.enqueue("A", b"A0", last=False)
        q.enqueue("B", b"B0", last=True)
        await asyncio.sleep(0.05)
        self.assertEqual(log, ["A0"])
        q.enqueue("A", b"A1", last=True)
        await q.drain()
        self.assertEqual(log, ["A0", "A1", "cue", "B0"])

    async def test_gives_up_on_a_stalled_reply_and_drops_its_late_chunk(self):
        q, log, clock = make(stall_s=0.05)
        q.enqueue("A", b"A0", last=False)
        q.enqueue("B", b"B0", last=True)
        await asyncio.sleep(0.2)
        q.enqueue("A", b"A1-late", last=True)
        await q.drain()
        self.assertEqual([x for x in log if x != "cue"], ["A0", "B0"])

    async def test_ack_goes_ahead_of_waiting_replies_without_interrupting(self):
        q, log, _ = make()
        q.enqueue("A", b"A0", last=True)
        await asyncio.sleep(0)  # A starts playing
        q.enqueue("B", b"B0", last=True)
        q.enqueue("ack", b"ack", last=True, priority=True)
        await q.drain()
        self.assertEqual(log, ["A0", "cue", "ack", "cue", "B0"])

    async def test_no_cue_after_a_quiet_gap(self):
        q, log, clock = make(cue_within_s=3.0)
        q.enqueue("A", b"A0", last=True)
        await q.drain()
        clock.t += 10
        q.enqueue("B", b"B0", last=True)
        await q.drain()
        self.assertEqual(log, ["A0", "B0"])


if __name__ == "__main__":
    unittest.main()
