#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${1:-$(node -p 'require("./package.json").version')}"
ROOT_NAME="codex-discord-${VERSION}"
OUTPUT_DIR="${2:-release}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [ ! -d node_modules ]; then
  NPM_CONFIG_CACHE="${TMPDIR:-/tmp}/codex-discord-build-cache" npm ci
fi
npm test
npm run build

mkdir -p "$OUTPUT_DIR" "$STAGE/$ROOT_NAME"
git archive --format=tar HEAD | tar -xf - -C "$STAGE/$ROOT_NAME"
cp -R dist "$STAGE/$ROOT_NAME/dist"

tar -czf "$OUTPUT_DIR/$ROOT_NAME.tar.gz" -C "$STAGE" "$ROOT_NAME"
(
  cd "$STAGE"
  zip -qr "$OLDPWD/$OUTPUT_DIR/$ROOT_NAME.zip" "$ROOT_NAME"
)

shasum -a 256 "$OUTPUT_DIR/$ROOT_NAME.tar.gz" "$OUTPUT_DIR/$ROOT_NAME.zip" > "$OUTPUT_DIR/SHA256SUMS.txt"
echo "Created release assets in $OUTPUT_DIR"
