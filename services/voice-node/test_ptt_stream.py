"""Tests for push-to-talk streaming. Run: python3 -m unittest test_ptt_stream"""

import sys
import types
import unittest
from unittest import mock

from voice_node import CHUNK_SAMPLES, VoiceNode


def fake_modules(node: VoiceNode, reads: int, on_read):
    """pyaudio + pynput stand-ins: the hotkey goes down at start and lifts after `reads` reads."""
    key = object()
    node._parse_hotkey = lambda _hotkey: [key]
    listener = {}

    class Listener:
        def __init__(self, on_press, on_release):
            listener.update(press=on_press, release=on_release)

        def start(self):
            listener["press"](key)

        def stop(self):
            pass

        def join(self):
            pass

    class Stream:
        n = 0

        def read(self, samples, exception_on_overflow=True):
            Stream.n += 1
            on_read(Stream.n)
            if Stream.n == reads:
                listener["release"](key)
                node._running = False
            return b"\x01\x00" * samples

        def stop_stream(self):
            pass

        def close(self):
            pass

    pyaudio = types.SimpleNamespace(paInt16=8, PyAudio=lambda: types.SimpleNamespace(
        open=lambda **_: Stream(), terminate=lambda: None))
    keyboard = types.SimpleNamespace(Listener=Listener)
    pynput = types.SimpleNamespace(keyboard=keyboard)
    return {"pyaudio": pyaudio, "pynput": pynput, "pynput.keyboard": keyboard}


def hold(reads: int, on_read=lambda n, node: None):
    """Hold the hotkey for `reads` frames on a connected node; return (ws messages, uploads)."""
    node = VoiceNode("http://server", "node", "model", push_to_talk=True, hotkey="right_cmd")
    node._running = True
    node._ws_gen = 1
    node._ws_ready = True
    sent: list[dict] = []
    uploads: list[list] = []
    loop = types.SimpleNamespace(call_soon_threadsafe=lambda _put, msg: sent.append(msg))
    node._send_frames = lambda frames, _loop: uploads.append(frames)
    with mock.patch.dict(sys.modules, fake_modules(node, reads, lambda n: on_read(n, node))):
        node._ptt_loop(loop)
    return [m["type"] for m in sent], uploads


class PushToTalkStreamTest(unittest.TestCase):
    def test_streams_the_hold_and_stops_on_release(self):
        types_, uploads = hold(4)
        self.assertEqual(types_, ["voice-stream.start"] + ["voice-stream.chunk"] * 4 + ["voice-stream.stop"])
        self.assertEqual(uploads, [])

    def test_uploads_the_whole_hold_when_the_connection_drops_mid_hold(self):
        def drop(n, node):
            if n == 3:
                node._ws_ready = False

        types_, uploads = hold(5, drop)
        self.assertEqual(types_, ["voice-stream.start"] + ["voice-stream.chunk"] * 2)
        self.assertEqual(len(uploads), 1)
        self.assertEqual(len(uploads[0]), 5)
        self.assertEqual(len(uploads[0][0]), CHUNK_SAMPLES * 2)

    def test_uploads_when_a_reconnect_lands_mid_hold(self):
        def reconnect(n, node):
            if n == 2:
                node._ws_gen += 1

        types_, uploads = hold(4, reconnect)
        self.assertNotIn("voice-stream.stop", types_)
        self.assertEqual(len(uploads[0]), 4)

    def test_uploads_when_the_server_turns_out_to_lack_voice_stream(self):
        def refuse(n, node):
            if n == 1:
                node._can_stream = False

        types_, uploads = hold(3, refuse)
        self.assertEqual(types_, ["voice-stream.start"])
        self.assertEqual(len(uploads[0]), 3)


if __name__ == "__main__":
    unittest.main()
