#!/usr/bin/env bash
# Install the LiteLLM proxy service for Sovereign.
#
# This proxy handles non-Claude model sessions only. Claude sessions bypass it
# and continue using OAuth auth directly to api.anthropic.com. No Anthropic API
# key is needed here.
#
# Prerequisites:
#   uv tool install 'litellm[proxy]'
#
# Run from the service directory:
#   cd services/litellm && bash setup.sh

set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SERVICE_DIR/systemd/litellm.service.template"
UNIT_DST="$HOME/.config/systemd/user/litellm.service"

echo "LiteLLM service setup"
echo "  Service dir: $SERVICE_DIR"

# Generate unit file from template
mkdir -p "$(dirname "$UNIT_DST")"
sed -e "s|@@SERVICE_DIR@@|$SERVICE_DIR|g" \
    -e "s|@@HOME@@|$HOME|g" \
    "$TEMPLATE" > "$UNIT_DST"
systemctl --user daemon-reload
echo "  Unit:        $UNIT_DST"

# Check litellm is installed
if command -v litellm &>/dev/null; then
    echo "  litellm:     $(litellm --version 2>/dev/null || echo 'installed')"
else
    echo "  litellm:     NOT FOUND — install with: uv tool install 'litellm[proxy]'"
fi

echo ""
echo "Next steps:"
echo "  1. Ensure llama-server is running at :9090"
echo "  2. Edit litellm.yaml to add/adjust model routes"
echo "  3. systemctl --user enable --now litellm"
echo "  4. Add to Sovereign config or env:"
echo "     SOVEREIGN_LITELLM_URL=http://localhost:4000"
echo ""
echo "To verify (litellm must be running):"
echo "  curl -s http://localhost:4000/v1/models | jq '.data[].id'"
echo ""
echo "Wind tunnel test:"
echo "  cd wind-tunnel && ./run.sh --litellm --scenario s32"
