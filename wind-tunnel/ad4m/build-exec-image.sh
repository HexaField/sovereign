#!/usr/bin/env bash
# Build the wind tunnel's AD4M executor image from an ad4m checkout.
#
#   AD4M_SRC=<ad4m checkout> ./wind-tunnel/ad4m/build-exec-image.sh [tag]
#
# The tag defaults to $AD4M_EXEC_IMAGE, else swt-ad4m-exec:latest; pass the
# same value as AD4M_EXEC_IMAGE to `run.sh --ad4m`.
#
# The checkout must already hold (nothing here compiles Rust):
#   <target>/release/ad4m-executor, <target>/release/ad4m
#       cargo build --release -p ad4m --bin ad4m-executor --bin ad4m
#       (<target> is $AD4M_TARGET_DIR, else <checkout>/target)
#   bootstrap-languages/local/dist/            the local bootstrap seed
#       (cd bootstrap-languages/local && node generate-seed.mjs)
#   bootstrap-languages/server-link-language/build/bundle.js
#       (cd bootstrap-languages/server-link-language && pnpm build)
# A release build of the executor needs the Deno snapshot files that ad4m's
# rust-executor build produces (see the ad4m repo's AGENTS.md).
#
# The binary runs on the image's Ubuntu 26.04 base, so build it on a host whose
# glibc is no newer than 26.04's (2.43).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${AD4M_SRC:?set AD4M_SRC to an ad4m checkout}"
TARGET="${AD4M_TARGET_DIR:-$SRC/target}"
TAG="${1:-${AD4M_EXEC_IMAGE:-swt-ad4m-exec:latest}}"
STAGE="$HERE/exec-image/.stage"

need() {
  [[ -e "$1" ]] || { echo "✗ missing $1 — $2" >&2; exit 1; }
}
need "$TARGET/release/ad4m-executor" "cargo build --release -p ad4m --bin ad4m-executor"
need "$TARGET/release/ad4m" "cargo build --release -p ad4m --bin ad4m"
need "$SRC/bootstrap-languages/local/dist/docker_seed.json" "run bootstrap-languages/local/generate-seed.mjs"
need "$SRC/bootstrap-languages/server-link-language/build/bundle.js" "build bootstrap-languages/server-link-language"
need "$SRC/docker-entrypoint.sh" "not an ad4m checkout?"

mkdir -p "$STAGE/seed" "$STAGE/server-link-language"
cp -f "$TARGET/release/ad4m-executor" "$TARGET/release/ad4m" "$STAGE/"
cp -rf "$SRC/bootstrap-languages/local/dist/." "$STAGE/seed/"
cp -f "$SRC/bootstrap-languages/server-link-language/build/bundle.js" "$STAGE/server-link-language/bundle.js"
cp -f "$SRC/docker-entrypoint.sh" "$STAGE/docker-entrypoint.sh"
git -C "$SRC" log -1 --format='%H %s' > "$STAGE/SOURCE" 2>/dev/null || echo unknown > "$STAGE/SOURCE"

echo "🔨 Building $TAG from $(cat "$STAGE/SOURCE")"
docker build -t "$TAG" "$HERE/exec-image"
echo "✓ $TAG — run the lane with AD4M_EXEC_IMAGE=$TAG ./wind-tunnel/run.sh --ad4m"
