#!/usr/bin/env bash
# Compatibility wrapper for historical rebuild usage.
# Delegates to the guarded Sovereign build/reload flow.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$REPO_DIR/bin/sovereign" build
