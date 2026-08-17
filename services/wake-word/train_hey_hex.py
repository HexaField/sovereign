#!/usr/bin/env python3
"""Train the "Hey Hex" wake word model using OpenWakeWord's automated pipeline.

This script handles the full lifecycle:
  1. Download required training data (RIRs, background noise, features)
  2. Set up Piper TTS for synthetic data generation
  3. Generate synthetic "hey hex" clips
  4. Augment clips with noise and reverb
  5. Train the model
  6. Export to ONNX

Run:
    cd services/wake-word
    .venv/bin/python train_hey_hex.py [--step generate|augment|train|all]

Outputs:
    training_output/hey_hex.onnx   — the trained wake word model
"""
import argparse
import logging
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import scipy.io.wavfile
import yaml

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [train] %(message)s",
)
log = logging.getLogger("train")

BASE_DIR = Path(__file__).parent
CONFIG_PATH = BASE_DIR / "hey_hex.yaml"
DATA_DIR = BASE_DIR / "training_data"
OUTPUT_DIR = BASE_DIR / "training_output"


def download_data():
    """Download required training datasets from HuggingFace."""
    import datasets

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Room impulse responses (MIT)
    rir_dir = DATA_DIR / "mit_rirs"
    if not rir_dir.exists():
        log.info("Downloading MIT room impulse responses...")
        rir_dir.mkdir()
        rir_dataset = datasets.load_dataset(
            "davidscripka/MIT_environmental_impulse_responses",
            split="train",
            streaming=True,
        )
        for row in rir_dataset:
            name = row["audio"]["path"].split("/")[-1]
            scipy.io.wavfile.write(
                str(rir_dir / name),
                16000,
                (row["audio"]["array"] * 32767).astype(np.int16),
            )
        log.info("RIRs downloaded: %d files", len(list(rir_dir.glob("*.wav"))))
    else:
        log.info("RIRs already present: %s", rir_dir)

    # 2. Background noise — AudioSet (1 partition)
    audioset_dir = DATA_DIR / "audioset_16k"
    if not audioset_dir.exists():
        log.info("Downloading AudioSet background noise...")
        audioset_dir.mkdir()
        raw_dir = DATA_DIR / "audioset_raw"
        raw_dir.mkdir(exist_ok=True)
        tar_file = raw_dir / "bal_train09.tar"
        if not tar_file.exists():
            subprocess.run(
                [
                    "wget",
                    "-O",
                    str(tar_file),
                    "https://huggingface.co/datasets/agkphysics/AudioSet/resolve/main/data/bal_train09.tar",
                ],
                check=True,
            )
        subprocess.run(["tar", "-xf", str(tar_file), "-C", str(raw_dir)], check=True)
        # Convert to 16kHz
        audio_files = list((raw_dir / "audio").glob("**/*.flac"))
        ds = datasets.Dataset.from_dict({"audio": [str(f) for f in audio_files]})
        ds = ds.cast_column("audio", datasets.Audio(sampling_rate=16000))
        for row in ds:
            name = row["audio"]["path"].split("/")[-1].replace(".flac", ".wav")
            scipy.io.wavfile.write(
                str(audioset_dir / name),
                16000,
                (row["audio"]["array"] * 32767).astype(np.int16),
            )
        log.info("AudioSet clips: %d", len(list(audioset_dir.glob("*.wav"))))
    else:
        log.info("AudioSet already present: %s", audioset_dir)

    # 3. Background noise — Free Music Archive (2 hours)
    fma_dir = DATA_DIR / "fma"
    if not fma_dir.exists():
        log.info("Downloading FMA background music (2 hours)...")
        fma_dir.mkdir()
        fma_dataset = datasets.load_dataset(
            "rudraml/fma", name="small", split="train", streaming=True
        )
        fma_iter = iter(
            fma_dataset.cast_column("audio", datasets.Audio(sampling_rate=16000))
        )
        n_clips = 2 * 3600 // 30  # 2 hours of 30s clips
        for i in range(n_clips):
            try:
                row = next(fma_iter)
            except StopIteration:
                break
            name = row["audio"]["path"].split("/")[-1].replace(".mp3", ".wav")
            scipy.io.wavfile.write(
                str(fma_dir / name),
                16000,
                (row["audio"]["array"] * 32767).astype(np.int16),
            )
        log.info("FMA clips: %d", len(list(fma_dir.glob("*.wav"))))
    else:
        log.info("FMA already present: %s", fma_dir)

    # 4. Pre-computed features (ACAV100M — ~17GB)
    features_file = DATA_DIR / "openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
    if not features_file.exists():
        log.info("Downloading ACAV100M features (~17GB, this takes a while)...")
        subprocess.run(
            [
                "wget",
                "-O",
                str(features_file),
                "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy",
            ],
            check=True,
        )
    else:
        log.info("ACAV100M features already present: %s", features_file)

    # 5. Validation set features (~11 hours)
    val_file = DATA_DIR / "validation_set_features.npy"
    if not val_file.exists():
        log.info("Downloading validation set features...")
        subprocess.run(
            [
                "wget",
                "-O",
                str(val_file),
                "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy",
            ],
            check=True,
        )
    else:
        log.info("Validation features already present: %s", val_file)


def setup_piper():
    """Clone and set up Piper TTS for synthetic data generation."""
    piper_dir = BASE_DIR / "piper-sample-generator"
    if not piper_dir.exists():
        log.info("Cloning piper-sample-generator...")
        subprocess.run(
            [
                "git",
                "clone",
                "--depth",
                "1",
                "https://github.com/rhasspy/piper-sample-generator",
                str(piper_dir),
            ],
            check=True,
        )
    # Download the voice model
    model_dir = piper_dir / "models"
    model_dir.mkdir(exist_ok=True)
    model_file = model_dir / "en_US-libritts_r-medium.pt"
    if not model_file.exists():
        log.info("Downloading Piper voice model...")
        subprocess.run(
            [
                "wget",
                "-O",
                str(model_file),
                "https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt",
            ],
            check=True,
        )
    log.info("Piper TTS ready: %s", piper_dir)


def run_training_step(step: str):
    """Run a single step of the OpenWakeWord training pipeline."""
    train_script = BASE_DIR / "openwakeword-train" / "openwakeword" / "train.py"
    if not train_script.exists():
        # Clone the full OpenWakeWord repo for training
        oww_dir = BASE_DIR / "openwakeword-train"
        if not oww_dir.exists():
            log.info("Cloning OpenWakeWord for training scripts...")
            subprocess.run(
                [
                    "git",
                    "clone",
                    "--depth",
                    "1",
                    "https://github.com/dscripka/openWakeWord.git",
                    str(oww_dir),
                ],
                check=True,
            )
        # Install training dependencies
        log.info("Installing training dependencies...")
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "torch",
                "torchinfo",
                "torchmetrics",
                "speechbrain==0.5.14",
                "audiomentations",
                "torch-audiomentations",
                "acoustics",
                "pronouncing",
                "datasets",
                "deep-phonemizer",
                "piper-phonemize",
                "webrtcvad",
                "mutagen",
            ],
            check=True,
        )

    flag_map = {
        "generate": "--generate_clips",
        "augment": "--augment_clips",
        "train": "--train_model",
    }
    flag = flag_map.get(step)
    if not flag:
        raise ValueError(f"Unknown step: {step}")

    log.info("Running training step: %s", step)
    subprocess.run(
        [
            sys.executable,
            str(train_script),
            "--training_config",
            str(CONFIG_PATH),
            flag,
        ],
        check=True,
        cwd=str(BASE_DIR),
    )


def install_model():
    """Copy the trained model to the standard location."""
    model_src = OUTPUT_DIR / "hey_hex.onnx"
    if not model_src.exists():
        log.error("Trained model not found at %s", model_src)
        return False

    # Install to the voice data directory
    voice_dir = Path.home() / ".sovereign" / "data" / "voice"
    model_dst = voice_dir / "hey_hex.onnx"
    voice_dir.mkdir(parents=True, exist_ok=True)

    import shutil

    shutil.copy2(str(model_src), str(model_dst))
    log.info("Model installed to %s", model_dst)
    return True


def main():
    parser = argparse.ArgumentParser(description="Train the Hey Hex wake word model")
    parser.add_argument(
        "--step",
        choices=["download", "setup", "generate", "augment", "train", "install", "all"],
        default="all",
        help="Which step to run (default: all)",
    )
    args = parser.parse_args()

    if args.step in ("download", "all"):
        download_data()

    if args.step in ("setup", "all"):
        setup_piper()

    if args.step in ("generate", "all"):
        run_training_step("generate")

    if args.step in ("augment", "all"):
        run_training_step("augment")

    if args.step in ("train", "all"):
        run_training_step("train")

    if args.step in ("install", "all"):
        install_model()

    log.info("Done.")


if __name__ == "__main__":
    main()
