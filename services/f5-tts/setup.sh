#!/usr/bin/env bash
# Install the F5-TTS voice service — generates the systemd unit from the
# template with machine-specific paths baked in.
#
# Run from the service directory:
#   cd services/f5-tts && bash setup.sh

set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SERVICE_DIR/systemd/f5-tts.service.template"
UNIT_DST="$HOME/.config/systemd/user/f5-tts.service"
VOICE_DIR="$HOME/.sovereign/data/voice"

echo "F5-TTS service setup"
echo "  Service dir: $SERVICE_DIR"

# Generate unit file from template
mkdir -p "$(dirname "$UNIT_DST")"
sed -e "s|@@F5_TTS_DIR@@|$SERVICE_DIR|g" \
    -e "s|@@HOME@@|$HOME|g" \
    "$TEMPLATE" > "$UNIT_DST"
systemctl --user daemon-reload
echo "  Unit:        $UNIT_DST"

# Ensure voice data dirs exist
mkdir -p "$VOICE_DIR/references" "$VOICE_DIR/output"

# Check for reference audio
REF="$VOICE_DIR/references/default.wav"
if [ -f "$REF" ]; then
    echo "  Reference:   $REF (found)"
else
    echo "  Reference:   $REF (MISSING — place your voice reference clip here)"
fi

# Check for venv
if [ -f "$SERVICE_DIR/.venv/bin/python" ]; then
    echo "  Venv:        OK"
else
    echo "  Venv:        MISSING — create with:"
    echo "    python -m venv .venv"
    echo "    .venv/bin/pip install torch torchaudio --index-url <your-torch-index>"
    echo "    .venv/bin/pip install -r requirements.txt"
    echo "    .venv/bin/pip install f5-tts uvicorn fastapi"
fi

echo ""
echo "Start with: systemctl --user enable --now f5-tts.service"
