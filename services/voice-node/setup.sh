#!/usr/bin/env bash
# Setup script for the Sovereign voice node.
# Creates a virtual environment, installs dependencies, and optionally
# installs a systemd user service (Linux/Pi) or launchd agent (macOS).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
SOVEREIGN_URL="${SOVEREIGN_URL:-http://localhost:5801}"

echo "=== Sovereign Voice Node Setup ==="

# 1. Create venv
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

echo "Installing Python dependencies..."
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$SCRIPT_DIR/requirements.txt"

# 2. Ensure voice data directory exists
mkdir -p "$HOME/.sovereign/data/voice"

# 3. Platform-specific service installation
OS="$(uname -s)"
case "$OS" in
    Linux)
        echo ""
        echo "=== Linux systemd service ==="
        UNIT_DIR="$HOME/.config/systemd/user"
        mkdir -p "$UNIT_DIR"

        UNIT_FILE="$UNIT_DIR/sovereign-voice-node.service"
        sed \
            -e "s|@@VOICE_NODE_DIR@@|$SCRIPT_DIR|g" \
            -e "s|@@HOME@@|$HOME|g" \
            -e "s|@@SOVEREIGN_URL@@|$SOVEREIGN_URL|g" \
            "$SCRIPT_DIR/systemd/sovereign-voice-node.service.template" \
            > "$UNIT_FILE"

        systemctl --user daemon-reload
        echo "Service installed: $UNIT_FILE"
        echo ""
        echo "Enable and start:"
        echo "  systemctl --user enable --now sovereign-voice-node"
        echo ""
        echo "View logs:"
        echo "  journalctl --user -u sovereign-voice-node -f"
        ;;

    Darwin)
        echo ""
        echo "=== macOS launchd agent ==="
        AGENT_DIR="$HOME/Library/LaunchAgents"
        mkdir -p "$AGENT_DIR"

        PLIST_FILE="$AGENT_DIR/com.sovereign.voice-node.plist"
        sed \
            -e "s|@@VOICE_NODE_DIR@@|$SCRIPT_DIR|g" \
            -e "s|@@HOME@@|$HOME|g" \
            -e "s|@@SOVEREIGN_URL@@|$SOVEREIGN_URL|g" \
            "$SCRIPT_DIR/launchd/com.sovereign.voice-node.plist.template" \
            > "$PLIST_FILE"

        echo "Launch agent installed: $PLIST_FILE"
        echo ""
        echo "Load and start:"
        echo "  launchctl load $PLIST_FILE"
        echo ""
        echo "Stop and unload:"
        echo "  launchctl unload $PLIST_FILE"
        echo ""
        echo "View logs:"
        echo "  tail -f $HOME/.sovereign/data/voice/voice-node.stdout.log"
        ;;

    *)
        echo "Unknown platform: $OS"
        echo "Run manually: $VENV_DIR/bin/python $SCRIPT_DIR/voice_node.py --server $SOVEREIGN_URL"
        ;;
esac

echo ""
echo "=== Setup complete ==="
echo "Test manually:"
echo "  $VENV_DIR/bin/python $SCRIPT_DIR/voice_node.py --list-devices"
echo "  $VENV_DIR/bin/python $SCRIPT_DIR/voice_node.py --server $SOVEREIGN_URL"
