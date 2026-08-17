# Wake Word Training

Trains a custom OpenWakeWord model for any wake phrase. Each Sovereign instance trains a wake word matching the configured assistant name. Produces an ONNX model that runs on any platform (Pi, macOS, Android via ONNX Runtime, Linux).

## Quick start

```bash
cd services/wake-word
python3 -m venv .venv
.venv/bin/pip install openwakeword torch speechbrain \
    audiomentations torch-audiomentations acoustics pronouncing \
    datasets deep-phonemizer webrtcvad mutagen scipy soundfile librosa pyyaml

# Train using the included example config
.venv/bin/python train.py --config hey_hex.yaml

# Or create your own config for a different wake phrase
cp hey_hex.yaml my_assistant.yaml
# Edit my_assistant.yaml: change target_phrase + model_name + negatives
.venv/bin/python train.py --config my_assistant.yaml
```

### Run steps individually

```bash
.venv/bin/python train.py --config hey_hex.yaml --step download   # ~17GB data
.venv/bin/python train.py --config hey_hex.yaml --step setup       # Piper TTS
.venv/bin/python train.py --config hey_hex.yaml --step generate    # Synthetic clips
.venv/bin/python train.py --config hey_hex.yaml --step augment     # Noise + reverb
.venv/bin/python train.py --config hey_hex.yaml --step train       # Train model
.venv/bin/python train.py --config hey_hex.yaml --step install     # Deploy to Sovereign
```

## Output

- `training_output/<model_name>.onnx` — the trained model
- Installed to `~/.sovereign/data/voice/wake_word.onnx` via the install step

## Creating a custom wake phrase

1. Copy `hey_hex.yaml` and rename it
2. Change `model_name` to match your phrase (e.g. `hey_nova`)
3. Change `target_phrase` to your wake phrase (e.g. `["hey nova"]`)
4. Update `custom_negative_phrases` with phonetically similar words
5. Run `train.py --config your_config.yaml`

## Configuration

Edit the YAML config to tune:

- `target_phrase` — the wake phrase to train on
- `model_name` — output model filename (without .onnx)
- `n_samples` — number of synthetic training clips (default: 50k)
- `custom_negative_phrases` — phrases to discriminate against
- `layer_size` — model width (default: 32, increase for accuracy)
- `steps` — training iterations (default: 50k)
- `threshold` targets for false positive rate and recall

## How it works

1. **Piper TTS** generates synthetic utterances of the wake phrase with varied speakers, speeds, and prosody
2. **Augmentation** adds room impulse responses, background noise, and music to simulate real-world conditions
3. **OpenWakeWord trainer** fits a small DNN on pre-computed audio features from ACAV100M (2000 hours of general audio) plus the synthetic positives
4. The trained model exports as a ~100KB ONNX file
