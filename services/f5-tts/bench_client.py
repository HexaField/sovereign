#!/usr/bin/env python3
"""Benchmark client for the F5-TTS voice service.

Sends short/medium/long synthesis requests against the running server,
times each end to end (wall clock, client-side), cross-checks RTF against
the server's own X-RTF header, and writes the resulting WAV files under
output/ for a listening check.

Run once server.py reports READY:
    .venv/bin/python bench_client.py
"""
import io
import time
import urllib.error
import urllib.request

import soundfile as sf

BASE_URL = "http://127.0.0.1:5812"
OUTPUT_DIR = "output"

BENCHMARK_TEXTS = {
    "short": "All diagnostics complete, sir. No anomalies detected.",
    "medium": (
        "The workshop sensors report steady readings across every station, sir. "
        "Ambient temperature holds within tolerance, and the compressor cycles "
        "on schedule. I flag nothing for your attention at this time."
    ),
    "long": (
        "Good morning, sir. Overnight the farm sensors logged twelve hours of "
        "continuous data without a single dropout. Soil moisture across the "
        "north paddock sits three percent below the irrigation threshold, so "
        "I scheduled the pump to start at first light. The workshop generator "
        "ran a clean self-test at 0400 and reports full charge. Two firmware "
        "updates await your approval before I push them to the field "
        "controllers. Weather models show a dry week ahead, which gives the "
        "concrete cure the time it needs before we mount the new gantry rail."
    ),
}


def wait_for_health(timeout_s: float = 300.0) -> dict:
    t0 = time.time()
    last_err = None
    while time.time() - t0 < timeout_s:
        try:
            with urllib.request.urlopen(f"{BASE_URL}/health", timeout=5) as resp:
                if resp.status == 200:
                    import json

                    return json.loads(resp.read())
        except (urllib.error.URLError, ConnectionRefusedError, OSError) as e:
            last_err = e
        time.sleep(2)
    raise RuntimeError(f"server never reported healthy: {last_err}")


def synthesize(text: str):
    body = f'{{"text": {text!r}}}'.encode() if False else None
    import json

    payload = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/synthesize",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=180) as resp:
        wav_bytes = resp.read()
        # resp.headers comes from email.message.Message — case-insensitive
        # .get() only works on the object itself, not after a dict() copy.
        headers = {"X-RTF": resp.headers.get("X-RTF"),
                   "X-Audio-Duration-Seconds": resp.headers.get("X-Audio-Duration-Seconds")}
    wall = time.time() - t0
    return wav_bytes, headers, wall


def main():
    print("Waiting for server health ...")
    health = wait_for_health()
    print(f"Server healthy: {health}")

    import os

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    results = []
    for label, text in BENCHMARK_TEXTS.items():
        n_words = len(text.split())
        n_chars = len(text)
        print(f"\n--- {label} ({n_words} words, {n_chars} chars) ---")
        print(f'  text: "{text[:80]}{"..." if len(text) > 80 else ""}"')

        wav_bytes, headers, wall = synthesize(text)

        data, sr = sf.read(io.BytesIO(wav_bytes))
        dur = len(data) / sr
        rtf_client = wall / dur if dur else float("inf")
        rtf_server = headers.get("X-RTF", "n/a")

        out_path = os.path.join(OUTPUT_DIR, f"bench_{label}.wav")
        sf.write(out_path, data, sr)

        print(f"  wall clock (client, incl. HTTP round trip): {wall:.2f}s")
        print(f"  audio duration: {dur:.2f}s")
        print(f"  RTF (client-measured): {rtf_client:.3f}x")
        print(f"  RTF (server-reported):  {rtf_server}x")
        print(f"  wrote {out_path}")

        results.append(
            {
                "label": label,
                "words": n_words,
                "chars": n_chars,
                "wall_s": wall,
                "audio_s": dur,
                "rtf_client": rtf_client,
                "rtf_server": rtf_server,
            }
        )

    print("\n=== SUMMARY ===")
    print(f"{'label':8s} {'words':>6s} {'wall_s':>8s} {'audio_s':>8s} {'rtf':>7s}")
    for r in results:
        print(
            f"{r['label']:8s} {r['words']:6d} {r['wall_s']:8.2f} "
            f"{r['audio_s']:8.2f} {r['rtf_client']:7.3f}"
        )

    print("\nBENCHMARK COMPLETE")


if __name__ == "__main__":
    main()
