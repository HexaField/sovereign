# Wake Word Training — "Hey Hex"

Trains a custom OpenWakeWord model for the "Hey Hex" wake phrase. Produces an ONNX model that runs on any platform (Pi, macOS, Android via ONNX Runtime, Linux).

## Quick start

```bash
cd services/wake-word
python3 -m venv .venv
.venv/bin/pip install openwakeword torch speechbrain==0.5.14 \
    audiomentations torch-audiomentations acoustics pronouncing \
    datasets deep-phonemizer piper-phonemize webrtcvad mutagen scipy

# Full pipeline (downloads ~17GB of training data)
.venv/bin/python train_hey_hex.py

# Or run steps individually
.venv/bin/python train_hey_hex.py --step download   # ~17GB data
.venv/bin/python train_hey_hex.py --step setup       # Piper TTS
.venv/bin/python train_hey_hex.py --step generate    # Synthetic clips
.venv/bin/python train_hey_hex.py --step augment     # Noise + reverb
.venv/bin/python train_hey_hex.py --step train       # Train model
.venv/bin/python train_hey_hex.py --step install     # Copy to ~/.sovereign/data/voice/
```

## Output

- `training_output/hey_hex.onnx` — the trained model
- Installed to `~/.sovereign/data/voice/hey_hex.onnx` via the install step

## Configuration

Edit `hey_hex.yaml` to tune:

- `n_samples` — number of synthetic training clips (default: 50k)
- `custom_negative_phrases` — phrases to discriminate against
- `layer_size` — model width (default: 32, increase for accuracy)
- `steps` — training iterations (default: 50k)
- `threshold` targets for false positive rate and recall

## How it works

1. **Piper TTS** generates 50k synthetic "hey hex" utterances with varied speakers, speeds, and prosody
2. **Augmentation** adds room impulse responses, background noise, and music to simulate real-world conditions
3. **OpenWakeWord trainer** fits a small DNN on pre-computed audio features from ACAV100M (2000 hours of general audio) plus the synthetic positives
4. The trained model exports as a ~100KB ONNX file
