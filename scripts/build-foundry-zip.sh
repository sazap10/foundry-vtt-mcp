#!/usr/bin/env bash
#
# Build the foundry-module into a sideloadable zip ready for Foundry's
# "Install Module" manifest URL.
#
# Usage:
#   bash scripts/build-foundry-zip.sh
#
# Output: packages/foundry-module/foundry-vtt-mcp.zip
#
# The zip is intentionally written into the branch (not gitignored) so the
# `download` URL in module.json can point at the raw GitHub URL of the zip
# during testing. For a production-quality release, attach the zip to a
# tagged GitHub release instead.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE_DIR="$REPO_ROOT/packages/foundry-module"
ZIP_PATH="$MODULE_DIR/foundry-vtt-mcp.zip"

# Files Foundry needs at runtime — must land at the zip ROOT so Foundry's
# installer can find module.json without a wrapping directory.
RUNTIME_PATHS=(
  module.json
  dist
  styles
  lang
  templates
  scripts
)

echo "==> Building foundry-module..."
(cd "$REPO_ROOT" && npm run build:foundry)

if [[ ! -f "$MODULE_DIR/dist/main.js" ]]; then
  echo "Error: $MODULE_DIR/dist/main.js is missing — build failed?" >&2
  exit 1
fi

for path in "${RUNTIME_PATHS[@]}"; do
  if [[ ! -e "$MODULE_DIR/$path" ]]; then
    echo "Error: missing $MODULE_DIR/$path" >&2
    exit 1
  fi
done

rm -f "$ZIP_PATH"

echo "==> Creating $ZIP_PATH..."
# Exclude TypeScript declaration files — they're pure dev artifacts the
# browser never reads. Keep .js.map for in-browser debugging.
(
  cd "$MODULE_DIR"
  zip -r -q "$ZIP_PATH" "${RUNTIME_PATHS[@]}" \
    -x '*.d.ts' \
    -x '*.d.ts.map'
)

echo "==> Done"
ls -lh "$ZIP_PATH"
echo
echo "Zip contents (first 20 entries):"
unzip -l "$ZIP_PATH" | head -25
