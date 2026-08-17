#!/usr/bin/env python3
"""Train a custom wake word model using OpenWakeWord's automated pipeline.

This script handles the full lifecycle:
  1. Download required training data (RIRs, background noise, features)
  2. Set up Piper TTS for synthetic data generation
  3. Generate synthetic wake-phrase clips
  4. Augment clips with noise and reverb
  5. Train the model
  6. Export to ONNX

The wake phrase comes from the training config YAML (target_phrase field).
Each Sovereign instance trains its own wake word matching the configured
assistant name.

Run:
    cd services/wake-word
    .venv/bin/python train.py --config my_wake_word.yaml
    .venv/bin/python train.py --config my_wake_word.yaml --step train

Outputs:
    training_output/<model_name>.onnx   — the trained wake word model
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
DATA_DIR = BASE_DIR / "training_data"
OUTPUT_DIR = BASE_DIR / "training_output"


def load_config(config_path: Path) -> dict:
    """Load and validate a training config YAML."""
    with open(config_path) as f:
        cfg = yaml.safe_load(f)
    if "model_name" not in cfg:
        raise ValueError(f"Config {config_path} must specify 'model_name'")
    if "target_phrase" not in cfg:
        raise ValueError(f"Config {config_path} must specify 'target_phrase'")
    return cfg


def _wget(url: str, dest: str):
    """Download a file via wget with resume support."""
    subprocess.run(["wget", "-c", "-O", dest, url], check=True)


def _convert_audio_dir(src_dir: Path, dst_dir: Path, ext: str = "*.flac"):
    """Convert audio files to 16kHz 16-bit WAV using soundfile + librosa."""
    import soundfile as sf
    import librosa

    dst_dir.mkdir(parents=True, exist_ok=True)
    files = list(src_dir.rglob(ext))
    log.info("Converting %d audio files to 16kHz WAV...", len(files))
    for f in files:
        try:
            audio, sr = sf.read(str(f))
            if sr != 16000:
                audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
            name = f.stem + ".wav"
            out_path = dst_dir / name
            scipy.io.wavfile.write(
                str(out_path), 16000, (audio * 32767).astype(np.int16)
            )
        except Exception as e:
            log.warning("Skip %s: %s", f.name, e)
    log.info("Converted: %d WAV files in %s", len(list(dst_dir.glob("*.wav"))), dst_dir)


def download_data():
    """Download required training datasets."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Room impulse responses (MIT) — clone the HF repo directly
    rir_dir = DATA_DIR / "mit_rirs"
    if not rir_dir.exists():
        log.info("Downloading MIT room impulse responses...")
        rir_repo = DATA_DIR / "mit_rirs_repo"
        if not rir_repo.exists():
            subprocess.run([
                "git", "clone", "--depth", "1",
                "https://huggingface.co/datasets/davidscripka/MIT_environmental_impulse_responses",
                str(rir_repo),
            ], check=True)
        # Find and convert audio files
        audio_dir = rir_repo / "data"
        if not audio_dir.exists():
            audio_dir = rir_repo  # dataset might store files at root
        _convert_audio_dir(rir_repo, rir_dir, ext="*.wav")
        # If no WAVs found, try other formats
        if not list(rir_dir.glob("*.wav")):
            for ext in ("*.flac", "*.mp3", "*.ogg"):
                _convert_audio_dir(rir_repo, rir_dir, ext=ext)
        count = len(list(rir_dir.glob("*.wav")))
        log.info("RIRs: %d files", count)
    else:
        log.info("RIRs already present: %s", rir_dir)

    # 2. Background noise — AudioSet (1 partition, direct tar download)
    audioset_dir = DATA_DIR / "audioset_16k"
    if not audioset_dir.exists():
        log.info("Downloading AudioSet background noise...")
        raw_dir = DATA_DIR / "audioset_raw"
        raw_dir.mkdir(exist_ok=True)
        tar_file = raw_dir / "bal_train09.tar"
        if not tar_file.exists():
            _wget(
                "https://huggingface.co/datasets/agkphysics/AudioSet/resolve/main/data/bal_train09.tar",
                str(tar_file),
            )
        subprocess.run(["tar", "-xf", str(tar_file), "-C", str(raw_dir)], check=True)
        _convert_audio_dir(raw_dir, audioset_dir, ext="*.flac")
    else:
        log.info("AudioSet already present: %s", audioset_dir)

    # 3. Background noise — Free Music Archive
    #    Clone a small subset via the HF API (avoids streaming audio decode issues)
    fma_dir = DATA_DIR / "fma"
    if not fma_dir.exists():
        log.info("Downloading FMA background music...")
        fma_repo = DATA_DIR / "fma_repo"
        if not fma_repo.exists():
            # Download a small sample — the full dataset runs too large
            subprocess.run([
                "git", "clone", "--depth", "1",
                "https://huggingface.co/datasets/rudraml/fma",
                str(fma_repo),
            ], check=True, env={**os.environ, "GIT_LFS_SKIP_SMUDGE": "0"})
        _convert_audio_dir(fma_repo, fma_dir, ext="*.mp3")
        if not list(fma_dir.glob("*.wav")):
            _convert_audio_dir(fma_repo, fma_dir, ext="*.flac")
        log.info("FMA clips: %d", len(list(fma_dir.glob("*.wav"))))
    else:
        log.info("FMA already present: %s", fma_dir)

    # 4. Pre-computed features (ACAV100M — ~17GB)
    features_file = DATA_DIR / "openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
    if not features_file.exists():
        log.info("Downloading ACAV100M features (~17GB, this takes a while)...")
        _wget(
            "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy",
            str(features_file),
        )
    else:
        log.info("ACAV100M features already present: %s", features_file)

    # 5. Validation set features (~11 hours)
    val_file = DATA_DIR / "validation_set_features.npy"
    if not val_file.exists():
        log.info("Downloading validation set features...")
        _wget(
            "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy",
            str(val_file),
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


def run_training_step(step: str, config_path: Path):
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
                "speechbrain",
                "audiomentations",
                "torch-audiomentations",
                "acoustics",
                "pronouncing",
                "datasets",
                "deep-phonemizer",
                "webrtcvad",
                "mutagen",
                "soundfile",
                "librosa",
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

    log.info("Running training step: %s (config: %s)", step, config_path.name)
    subprocess.run(
        [
            sys.executable,
            str(train_script),
            "--training_config",
            str(config_path),
            flag,
        ],
        check=True,
        cwd=str(BASE_DIR),
    )


def install_model(config: dict):
    """Copy the trained model to the standard Sovereign voice data directory."""
    model_name = config["model_name"]
    model_src = OUTPUT_DIR / f"{model_name}.onnx"
    if not model_src.exists():
        log.error("Trained model not found at %s", model_src)
        return False

    # Install to the voice data directory
    voice_dir = Path.home() / ".sovereign" / "data" / "voice"
    model_dst = voice_dir / "wake_word.onnx"
    voice_dir.mkdir(parents=True, exist_ok=True)

    import shutil

    shutil.copy2(str(model_src), str(model_dst))
    log.info("Model installed to %s (from %s)", model_dst, model_name)
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Train a custom wake word model for Sovereign"
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=BASE_DIR / "hey_sovereign.yaml",
        help="Training config YAML (default: hey_sovereign.yaml)",
    )
    parser.add_argument(
        "--step",
        choices=["download", "setup", "generate", "augment", "train", "install", "all"],
        default="all",
        help="Which step to run (default: all)",
    )
    args = parser.parse_args()

    config = load_config(args.config)
    phrase = config.get("target_phrase", ["(unknown)"])
    if isinstance(phrase, list):
        phrase = phrase[0]
    log.info(
        "Training wake word model: %s (phrase: %r)",
        config["model_name"],
        phrase,
    )

    if args.step in ("download", "all"):
        download_data()

    if args.step in ("setup", "all"):
        setup_piper()

    if args.step in ("generate", "all"):
        run_training_step("generate", args.config)

    if args.step in ("augment", "all"):
        run_training_step("augment", args.config)

    if args.step in ("train", "all"):
        run_training_step("train", args.config)

    if args.step in ("install", "all"):
        install_model(config)

    log.info("Done.")


if __name__ == "__main__":
    main()
